//! The evaluation channel: lets a test driver on the host run JavaScript in the
//! app's page and read the result. **Debug builds on Linux only**: this module is
//! not compiled in a release build, and a debug build opens the channel only when
//! the environment names a socket (`DK_EVAL_SOCKET`, which `dk run linux-desktop`
//! sets). It is used by `dk test linux-desktop` (the Linux driver in
//! `@droid-kit/devtest`).
//!
//! # Where
//!
//! A Unix stream socket at the path in `DK_EVAL_SOCKET`. `dk` makes a directory
//! `$XDG_RUNTIME_DIR/droid-kit/<identifier>` (mode 0700) on the host, mounts it into
//! the container at `/run/dk/eval`, and names `/run/dk/eval/eval.sock`. The app
//! removes a stale file, binds, and sets the socket's mode to 0600. Nothing is
//! registered on the session bus.
//!
//! # Protocol
//!
//! One JSON object per line in each direction. The app answers each request
//! with exactly one line, in order. Requests:
//!
//! - `{"id": 1, "op": "ping"}` answers `{"id": 1, "ok": true, "value": {"identifier": "...", "windows": ["main"]}}`.
//! - `{"id": 2, "op": "eval", "expression": "document.title", "timeoutMs": 30000}`
//!   evaluates the JavaScript expression in the first window (the one labelled
//!   `main` if there is one), awaits it if it is a promise, and answers
//!   `{"id": 2, "ok": true, "value": <the result as JSON>}`. `undefined` comes back as
//!   `null`. A result that is not JSON-serialisable, or an exception, answers
//!   `{"id": 2, "ok": false, "error": "<message>"}`.
//! - `{"id": 3, "op": "screenshot", "path": "/abs/file.png"}` writes a PNG of the
//!   window's web view (only the app, whatever else is on the screen) and answers
//!   `{"id": 3, "ok": true, "value": "/abs/file.png"}`.
//!
//! An unknown `op`, a line that is not JSON or a request that times out answers
//! with `"ok": false`. The `id` is echoed (0 when it could not be read). A client
//! may keep the connection open for many requests.

use std::{
    io::{BufRead, BufReader, Write},
    os::unix::{fs::PermissionsExt, net::UnixListener},
    path::PathBuf,
    sync::mpsc,
    time::Duration,
};

use java_script_core::ValueExt;
use serde_json::{Value, json};
use tauri::{AppHandle, Manager, Runtime};
use webkit2gtk::{WebViewExt, gio};

const DEFAULT_TIMEOUT_MS: u64 = 30_000;

/// Opens the channel if `DK_EVAL_SOCKET` is set. It runs on its own threads, and each page request is handed to the GTK main thread.
pub fn start<R: Runtime>(app: AppHandle<R>) {
    let Some(path) = std::env::var_os("DK_EVAL_SOCKET").map(PathBuf::from) else {
        return;
    };
    let _ = std::fs::remove_file(&path);
    let listener = match UnixListener::bind(&path) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("DK_EVAL_FAILED cannot listen on {}: {e}", path.display());
            return;
        }
    };
    let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    eprintln!("DK_EVAL_LISTENING {}", path.display());
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let app = app.clone();
            std::thread::spawn(move || serve(app, stream));
        }
    });
}

fn serve<R: Runtime>(app: AppHandle<R>, stream: std::os::unix::net::UnixStream) {
    let Ok(mut out) = stream.try_clone() else { return };
    for line in BufReader::new(stream).lines() {
        let Ok(line) = line else { return };
        if line.trim().is_empty() {
            continue;
        }
        let reply = handle(&app, &line);
        if writeln!(out, "{reply}").is_err() {
            return;
        }
    }
}

fn handle<R: Runtime>(app: &AppHandle<R>, line: &str) -> Value {
    let request: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(e) => return json!({ "id": 0, "ok": false, "error": format!("not JSON: {e}") }),
    };
    let id = request.get("id").cloned().unwrap_or(json!(0));
    let result = match request.get("op").and_then(Value::as_str) {
        Some("ping") => Ok(json!({ "identifier": app.config().identifier, "windows": app.webview_windows().keys().collect::<Vec<_>>() })),
        Some("eval") => match request.get("expression").and_then(Value::as_str) {
            Some(expression) => eval(app, expression, timeout(&request)),
            None => Err("eval needs an expression".into()),
        },
        Some("screenshot") => match request.get("path").and_then(Value::as_str) {
            Some(path) => screenshot(app, path, timeout(&request)),
            None => Err("screenshot needs a path".into()),
        },
        Some(other) => Err(format!("unknown op {other:?}")),
        None => Err("the request has no op".into()),
    };
    match result {
        Ok(value) => json!({ "id": id, "ok": true, "value": value }),
        Err(error) => json!({ "id": id, "ok": false, "error": error }),
    }
}

fn timeout(request: &Value) -> Duration {
    Duration::from_millis(request.get("timeoutMs").and_then(Value::as_u64).unwrap_or(DEFAULT_TIMEOUT_MS))
}

fn window<R: Runtime>(app: &AppHandle<R>) -> Result<tauri::WebviewWindow<R>, String> {
    let windows = app.webview_windows();
    windows.get("main").cloned().or_else(|| windows.into_values().next()).ok_or_else(|| "the app has no window yet".to_string())
}

/// The body of an async function: the expression, awaited and turned into a JSON string inside the page.
/// (`evaluate_javascript` does not wait for a promise; `call_async_javascript_function` does.)
fn wrap(expression: &str) -> String {
    let expression = expression.trim().trim_end_matches(';');
    format!("const __dk = await ({expression}\n); return JSON.stringify(__dk === undefined ? null : __dk);")
}

fn eval<R: Runtime>(app: &AppHandle<R>, expression: &str, timeout: Duration) -> Result<Value, String> {
    let window = window(app)?;
    let script = wrap(expression);
    let (tx, rx) = mpsc::channel::<Result<String, String>>();
    window
        .with_webview(move |platform| {
            platform.inner().call_async_javascript_function(&script, None, None, None, None::<&gio::Cancellable>, move |result| {
                let _ = tx.send(result.map(|value| value.to_str().to_string()).map_err(|e| e.message().to_string()));
            });
        })
        .map_err(|e| e.to_string())?;
    let json = rx.recv_timeout(timeout).map_err(|_| format!("the page did not answer within {} ms", timeout.as_millis()))??;
    serde_json::from_str(&json).map_err(|e| format!("the result is not JSON ({e}): {json}"))
}

fn screenshot<R: Runtime>(app: &AppHandle<R>, path: &str, timeout: Duration) -> Result<Value, String> {
    let window = window(app)?;
    let (tx, rx) = mpsc::channel::<Result<(), String>>();
    let target = PathBuf::from(path);
    window.with_webview(move |platform| crate::screenshot::snapshot_to(platform.inner(), target, move |r| drop(tx.send(r)))).map_err(|e| e.to_string())?;
    rx.recv_timeout(timeout).map_err(|_| "the snapshot did not finish".to_string())??;
    Ok(json!(path))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expressions_are_wrapped_to_return_json_after_awaiting() {
        let s = wrap("  document.title; ");
        assert!(s.starts_with("const __dk = await (document.title\n);"), "{s}");
        assert!(s.ends_with("return JSON.stringify(__dk === undefined ? null : __dk);"));
        assert!(wrap("1 + 1;;").contains("await (1 + 1\n)"));
    }

    #[test]
    fn requests_say_what_is_wrong() {
        // No window is needed to refuse a request.
        assert!(timeout(&json!({})) == Duration::from_millis(DEFAULT_TIMEOUT_MS));
        assert!(timeout(&json!({ "timeoutMs": 5 })) == Duration::from_millis(5));
    }
}

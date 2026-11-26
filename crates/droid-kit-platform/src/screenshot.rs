//! A PNG of the app's own web view, for `dk run`. It asks WebKit for a snapshot
//! of what the view shows, so no other window can be in the picture, whatever
//! has focus.

use std::{
    fs::File,
    path::PathBuf,
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};

use tauri::{Manager, Runtime};
use webkit2gtk::{SnapshotOptions, SnapshotRegion, WebViewExt, gio};

static TAKEN: AtomicBool = AtomicBool::new(false);

/// For a page that never says it is ready: `DK_SCREENSHOT_AFTER=<seconds>` takes
/// the picture of the first window anyway, so a hang can be seen.
pub fn arm_fallback<R: Runtime>(app: tauri::AppHandle<R>) {
    let (Some(path), Some(secs)) = (
        std::env::var_os("DK_SCREENSHOT"),
        std::env::var("DK_SCREENSHOT_AFTER").ok().and_then(|v| v.parse::<u64>().ok()),
    ) else {
        return;
    };
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(secs));
        if TAKEN.load(Ordering::SeqCst) {
            return;
        }
        match app.webview_windows().into_values().next() {
            Some(window) => capture(window, path.into()),
            None => eprintln!("DK_SCREENSHOT_FAILED the app has no window"),
        }
    });
}

/// Writes the snapshot after a short wait, so a window that is still settling
/// to its size has done so. The outcome goes to the log as `DK_SCREENSHOT <file>`
/// or `DK_SCREENSHOT_FAILED <reason>`.
pub fn capture<R: Runtime>(window: tauri::WebviewWindow<R>, path: PathBuf) {
    if TAKEN.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(600));
        let failed = path.clone();
        let started = window.with_webview(move |platform| {
            platform.inner().snapshot(SnapshotRegion::Visible, SnapshotOptions::NONE, None::<&gio::Cancellable>, move |result| {
                match result.map_err(|e| e.to_string()).and_then(|surface| write(surface, &path)) {
                    Ok(()) => eprintln!("DK_SCREENSHOT {}", path.display()),
                    Err(e) => eprintln!("DK_SCREENSHOT_FAILED {e}"),
                }
            });
        });
        if let Err(e) = started {
            eprintln!("DK_SCREENSHOT_FAILED {} ({e})", failed.display());
        }
    });
}

/// Writes a snapshot of the web view to `path` and calls `done` with the outcome. Runs on the GTK main thread.
/// For the evaluation channel, which takes any number of pictures; `capture` above is the one `dk run` asks for.
#[cfg(debug_assertions)]
pub fn snapshot_to(webview: webkit2gtk::WebView, path: PathBuf, done: impl FnOnce(Result<(), String>) + 'static) {
    webview.snapshot(SnapshotRegion::Visible, SnapshotOptions::NONE, None::<&gio::Cancellable>, move |result| {
        done(result.map_err(|e| e.to_string()).and_then(|surface| write(surface, &path)));
    });
}

fn write(surface: cairo::Surface, path: &PathBuf) -> Result<(), String> {
    let image = cairo::ImageSurface::try_from(surface).map_err(|_| "the snapshot is not an image surface".to_string())?;
    let mut file = File::create(path).map_err(|e| format!("{}: {e}", path.display()))?;
    image.write_to_png(&mut file).map_err(|e| e.to_string())
}

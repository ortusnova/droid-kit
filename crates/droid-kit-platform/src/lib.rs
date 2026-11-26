//! Tauri plugin: platform facts for the boot script, Android system bars, and
//! the back action's "send to background".
//!
//! Its init script sets `window.__DK_NATIVE__` before any page script runs:
//! the platform, the web engine and its version where the user agent does not
//! carry it (WebKitGTK), and whether this is a debug build.
//!
//! Debug builds on Linux also have the app's own snapshot for `dk run` (`screenshot`)
//! and the evaluation channel for `dk test` (`evalchannel`, whose module documentation
//! is the protocol). Neither is compiled into a release build.

#[cfg(target_os = "linux")]
mod screenshot;
#[cfg(all(target_os = "linux", debug_assertions))]
mod evalchannel;

use serde::Deserialize;
use tauri::{
    Manager, Runtime,
    plugin::{Builder, TauriPlugin},
};

#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "com.ortusnova.droidkit.platform";

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[cfg(target_os = "android")]
    #[error(transparent)]
    PluginInvoke(#[from] tauri::plugin::mobile::PluginInvokeError),
    #[error(transparent)]
    Tauri(#[from] tauri::Error),
}

impl serde::Serialize for Error {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

type CmdResult<T> = std::result::Result<T, Error>;

struct Platform<R: Runtime> {
    #[cfg(target_os = "android")]
    handle: tauri::plugin::PluginHandle<R>,
    #[cfg(not(target_os = "android"))]
    _marker: std::marker::PhantomData<fn() -> R>,
}

/// Called by the page once its first screen has rendered. `dk run` waits for
/// this line on the app's standard error (Linux). On Android the page also
/// logs `DK_READY` to the console, which Tauri forwards to logcat.
///
/// Linux debug builds started with `DK_SCREENSHOT=<file>` then write a PNG of
/// the app's own web view to that file, so `dk run` needs no window capture.
/// If the page never gets ready, `DK_SCREENSHOT_AFTER=<seconds>` writes it anyway.
#[tauri::command]
fn ready<R: Runtime>(_webview: tauri::WebviewWindow<R>) {
    eprintln!("DK_READY");
    #[cfg(all(target_os = "linux", debug_assertions))]
    if let Some(path) = std::env::var_os("DK_SCREENSHOT") {
        screenshot::capture(_webview, path.into());
    }
}

/// Uncaught errors from the page, so they reach the same log as `DK_READY`.
#[tauri::command]
fn report_error(message: String) {
    eprintln!("DK_ERROR {message}");
}

#[derive(Debug, Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SystemBars {
    /// Whether the page is dark, so the bar icons must be light.
    dark: bool,
    /// The page background, `#rrggbb`, painted behind the web view.
    background: Option<String>,
    /// The app's theme choice: `light`, `dark` or `system`.
    preference: Option<String>,
}

// A command that calls into Kotlin is `async` and awaits `run_mobile_plugin_async`. Tauri runs a
// sync command inline while it holds the plugin store's lock, and Kotlin answers from Android's
// main thread, which may be waiting for that same lock (it takes it when a page finishes loading):
// the two wait for each other and the app stops responding.
#[tauri::command]
async fn set_system_bars<R: Runtime>(
    app: tauri::AppHandle<R>,
    dark: bool,
    background: Option<String>,
    preference: Option<String>,
) -> CmdResult<()> {
    let _bars = SystemBars { dark, background, preference };
    #[cfg(target_os = "android")]
    app.state::<Platform<R>>().handle.run_mobile_plugin_async::<()>("setSystemBars", _bars).await?;
    #[cfg(not(target_os = "android"))]
    let _ = app.state::<Platform<R>>();
    Ok(())
}

#[tauri::command]
async fn move_to_background<R: Runtime>(app: tauri::AppHandle<R>) -> CmdResult<()> {
    #[cfg(target_os = "android")]
    app.state::<Platform<R>>().handle.run_mobile_plugin_async::<()>("moveToBackground", ()).await?;
    #[cfg(not(target_os = "android"))]
    let _ = app.state::<Platform<R>>();
    Ok(())
}

fn platform_name() -> &'static str {
    if cfg!(target_os = "android") {
        "android"
    } else if cfg!(target_os = "ios") {
        "ios"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "unknown"
    }
}

/// The web engine and, where the user agent does not tell, its version.
fn engine() -> (&'static str, Option<String>) {
    #[cfg(target_os = "linux")]
    {
        // SAFETY: these WebKitGTK functions only return compile-time constants of the loaded library.
        let (major, minor, micro) = unsafe {
            (
                webkit2gtk_sys::webkit_get_major_version(),
                webkit2gtk_sys::webkit_get_minor_version(),
                webkit2gtk_sys::webkit_get_micro_version(),
            )
        };
        ("webkitgtk", Some(format!("{major}.{minor}.{micro}")))
    }
    #[cfg(target_os = "android")]
    {
        // The reduced user agent still carries the WebView's major version.
        ("android-webview", None)
    }
    #[cfg(not(any(target_os = "linux", target_os = "android")))]
    {
        ("unknown", None)
    }
}

/// Makes the Wayland app id of the app's windows the
/// application identifier, the same name Android uses for the package.
///
/// GTK 3 names a toplevel after `g_get_prgname()` when the window is first
/// shown, and Tauri leaves that at the executable's name. Tauri's own
/// `app.enableGTKAppId` does not help: it only gives the `GApplication` the
/// identifier, which also makes GTK own that name on the session bus, where
/// the reminders plugin already owns it. A plugin's setup runs when the app is
/// built, after GTK is initialised and before Tauri creates the windows from
/// the config, so the name is in place in time. `g_set_prgname` may be called
/// again after `gtk_init`.
#[cfg(target_os = "linux")]
fn set_window_app_id(identifier: &str) {
    webkit2gtk::glib::set_prgname(Some(identifier));
}

fn init_script() -> String {
    let (name, version) = engine();
    // Debug builds only: the screen to open first, from `dk run --route`.
    let start_route = if cfg!(debug_assertions) { std::env::var("DK_START_ROUTE").ok() } else { None };
    let native = serde_json::json!({
        "platform": platform_name(),
        "engine": { "name": name, "version": version },
        "debug": cfg!(debug_assertions),
        "startRoute": start_route,
    });
    format!("window.__DK_NATIVE__ = {native};")
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("droid-kit-platform")
        .js_init_script(init_script())
        .invoke_handler(tauri::generate_handler![ready, report_error, set_system_bars, move_to_background])
        .setup(|app, _api| {
            #[cfg(target_os = "android")]
            let platform = Platform { handle: _api.register_android_plugin(PLUGIN_IDENTIFIER, "PlatformPlugin")? };
            #[cfg(not(target_os = "android"))]
            let platform = Platform::<R> { _marker: std::marker::PhantomData };
            app.manage(platform);
            #[cfg(target_os = "linux")]
            set_window_app_id(&app.config().identifier);
            #[cfg(all(target_os = "linux", debug_assertions))]
            screenshot::arm_fallback(app.clone());
            #[cfg(all(target_os = "linux", debug_assertions))]
            evalchannel::start(app.clone());
            Ok(())
        })
        .build()
}

//! Tauri plugin: form factor, insets, theme, system bars and engine version.

use tauri::{
    Runtime,
    plugin::{Builder, TauriPlugin},
};

/// Called by the page once its first screen has rendered. `dk run` waits for
/// this line on the app's standard error (Linux). On Android the page also
/// logs `DK_READY` to the console, which Tauri forwards to logcat.
#[tauri::command]
fn ready() {
    eprintln!("DK_READY");
}

/// Uncaught errors from the page, so they reach the same log as `DK_READY`.
#[tauri::command]
fn report_error(message: String) {
    eprintln!("DK_ERROR {message}");
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("droid-kit-platform")
        .invoke_handler(tauri::generate_handler![ready, report_error])
        .build()
}

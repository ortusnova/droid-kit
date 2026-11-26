#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(droid_kit_platform::init())
        .plugin(droid_kit_reminders::init())
        .plugin(droid_kit_store::init())
        .run(tauri::generate_context!())
        .expect("error while running __DK_NAME__");
}

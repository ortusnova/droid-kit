#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(droid_kit_platform::init())
        .run(tauri::generate_context!())
        .expect("error while running the gallery");
}

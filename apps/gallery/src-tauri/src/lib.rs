use tauri::Manager;

/// Saves the Design page's token choices where `dk tokens apply` reads them:
/// `token-choices.json` in the app's data directory. Returns the file's path.
#[tauri::command]
fn save_token_choices(app: tauri::AppHandle, json: String) -> Result<String, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("token-choices.json");
    std::fs::write(&path, json).map_err(|e| e.to_string())?;
    Ok(path.display().to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(droid_kit_platform::init())
        .plugin(droid_kit_reminders::init())
        .invoke_handler(tauri::generate_handler![save_token_choices])
        .run(tauri::generate_context!())
        .expect("error while running the gallery");
}

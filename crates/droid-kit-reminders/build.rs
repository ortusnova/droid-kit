const COMMANDS: &[&str] = &["schedule", "cancel", "list", "capabilities", "take_opened"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).android_path("android").build();
}

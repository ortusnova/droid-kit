const COMMANDS: &[&str] = &["ready", "report_error", "set_system_bars", "move_to_background"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).android_path("android").build();
}

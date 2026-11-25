const COMMANDS: &[&str] = &["ready", "report_error"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}

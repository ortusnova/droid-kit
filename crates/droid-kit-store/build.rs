const COMMANDS: &[&str] = &["open", "select", "execute", "batch"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}

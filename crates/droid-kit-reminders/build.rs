// `register_listener` and `remove_listener` are not handled in Rust: on Android
// Tauri forwards them to the Kotlin plugin, which sends the `tapped` event
// (JS `addPluginListener`). They are listed so the page is allowed to call them.
const COMMANDS: &[&str] = &["schedule", "cancel", "list", "capabilities", "take_opened", "open_settings", "register_listener", "remove_listener"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).android_path("android").ios_path("ios").build();
}

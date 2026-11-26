//! Names the app side and the service agree on, and the systemd unit text.

/// The interface of the service's own object and of the app's change signal.
pub const INTERFACE: &str = "dev.droidkit.Reminders1";
/// Emitted by the app, on the service's object path, whenever `reminders.json` changed.
pub const CHANGED: &str = "Changed";
/// The `org.freedesktop.Application` action the service calls on a running app.
pub const OPEN_ACTION: &str = "open-reminder";
/// The command-line argument that starts the app for a tapped reminder: `--dk-reminder <id>`.
pub const LAUNCH_ARG: &str = "--dk-reminder";

pub fn unit_name(app_id: &str) -> String {
    format!("{app_id}-reminders.service")
}

/// The service's well-known bus name; PowerDevil calls `wakeupCallback` on it.
pub fn service_bus_name(app_id: &str) -> String {
    format!("{app_id}.Reminders")
}

fn path_element(s: &str) -> String {
    s.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '_' }).collect()
}

/// The service's object path, where the app's `Changed` signal is sent.
pub fn service_path(app_id: &str) -> String {
    format!("/dev/droidkit/Reminders/{}", path_element(app_id))
}

/// The app's `org.freedesktop.Application` object path (the application id with dots as slashes).
pub fn app_path(app_id: &str) -> String {
    let elements: Vec<String> = app_id.split('.').map(path_element).collect();
    format!("/{}", elements.join("/"))
}

/// What the unit file needs.
pub struct UnitSpec<'a> {
    pub app_id: &'a str,
    pub app_name: &'a str,
    pub service_exe: &'a str,
    pub data_dir: &'a str,
    /// Run as `<launcher> --dk-reminder <id>` to start the app when it is not running.
    pub launcher: &'a str,
}

/// Quotes one word for a systemd `ExecStart=` line.
fn quote(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '%' => out.push_str("%%"),
            '$' => out.push_str("$$"),
            '\n' => out.push_str("\\n"),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

pub fn render_unit(spec: &UnitSpec) -> String {
    let words = [
        quote(spec.service_exe),
        quote("--app-id"),
        quote(spec.app_id),
        quote("--app-name"),
        quote(spec.app_name),
        quote("--data-dir"),
        quote(spec.data_dir),
        quote("--launcher"),
        quote(spec.launcher),
    ];
    let description = spec.app_name.replace('\n', " ");
    format!(
        "# Written by droid-kit-reminders. Delivers {description}'s reminders when the app is closed.\n\
         [Unit]\n\
         Description=droid-kit reminders for {description}\n\
         \n\
         [Service]\n\
         Type=exec\n\
         ExecStart={}\n\
         Restart=on-failure\n\
         RestartSec=2\n\
         # An app the service started stays open when the service restarts.\n\
         KillMode=process\n\
         \n\
         [Install]\n\
         WantedBy=default.target\n",
        words.join(" ")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_follow_the_app_id() {
        assert_eq!(unit_name("com.ortusnova.droidkit.gallery"), "com.ortusnova.droidkit.gallery-reminders.service");
        assert_eq!(service_bus_name("com.ortusnova.droidkit.gallery"), "com.ortusnova.droidkit.gallery.Reminders");
        assert_eq!(app_path("com.ortusnova.droid-kit.gallery"), "/com/ortusnova/droid_kit/gallery");
        assert_eq!(service_path("com.a-b.c"), "/dev/droidkit/Reminders/com_a_b_c");
    }

    #[test]
    fn unit_text_quotes_awkward_paths() {
        let text = render_unit(&UnitSpec {
            app_id: "com.example.app",
            app_name: "My \"App\"",
            service_exe: "/opt/my apps/droid-kit-reminderd",
            data_dir: "/home/u/.local/share/com.example.app",
            launcher: "/home/u/100%/launch$.sh",
        });
        assert!(text.contains("ExecStart=\"/opt/my apps/droid-kit-reminderd\" \"--app-id\" \"com.example.app\" \"--app-name\" \"My \\\"App\\\"\""), "{text}");
        assert!(text.contains("\"--launcher\" \"/home/u/100%%/launch$$.sh\""), "{text}");
        assert!(text.contains("WantedBy=default.target"));
        assert!(text.contains("KillMode=process"));
    }
}

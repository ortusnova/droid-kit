//! The Linux desktop target: build in the Alpine (musl) image, which matches
//! postmarketOS, and run the result on this machine's Wayland session.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};
use std::time::Instant;

use anyhow::{Context, Result};

use crate::android::{Outcome, report};
use crate::config::{App, stamp};
use crate::proc::{output, run, sleep, succeeds};

/// The build image's definition, built into dk so any copy of dk can recreate it.
pub const CONTAINERFILE: &str = include_str!("../../../containers/linux-build/Containerfile");

pub fn ensure_image(image: &str) -> Result<()> {
    if succeeds(Command::new("podman").args(["image", "exists", image])) {
        return Ok(());
    }
    let dir = std::env::temp_dir().join("dk-linux-image");
    fs::create_dir_all(&dir)?;
    fs::write(dir.join("Containerfile"), CONTAINERFILE)?;
    run(Command::new("podman").args(["build", "-t", image]).arg(&dir))
}

fn cache_dir() -> Result<String> {
    let home = std::env::var("HOME").context("HOME is not set")?;
    let dir = format!("{home}/.cache/droid-kit");
    for sub in ["cargo", "pnpm-store"] {
        fs::create_dir_all(format!("{dir}/{sub}"))?;
    }
    Ok(dir)
}

/// Mounts that make the app's paths, and any local kit checkout next to it,
/// valid at the same absolute paths inside the container.
fn mounts(app: &App) -> Vec<String> {
    let mut v = vec![format!("{0}:{0}", app.root.display())];
    let local_kit = app.dir.join(".dk/kit-local");
    if let Ok(path) = fs::read_to_string(local_kit) {
        v.push(format!("{0}:{0}", path.trim()));
    }
    v
}

pub fn build(app: &App) -> Result<()> {
    ensure_image(&app.linux.image)?;
    // Dependencies are installed on the host: the workspace asks pnpm for both
    // glibc and musl native packages, so one node_modules serves both.
    run(Command::new("pnpm").arg("install").current_dir(&app.dir))?;
    let mut c = Command::new("podman");
    c.args(["run", "--rm", "--security-opt", "label=disable", "--userns=keep-id"]);
    for m in mounts(app) {
        c.args(["-v", &m]);
    }
    c.args(["-v", &format!("{}:/cache", cache_dir()?)])
        .args(["-e", &format!("CARGO_TARGET_DIR={}/target/alpine", app.root.display())])
        .args(["-e", "HOME=/cache/home"])
        .args(["-w", &app.dir.to_string_lossy()])
        .arg(&app.linux.image)
        .args(["tauri", "build", "--debug", "--no-bundle"]);
    run(&mut c)?;
    build_reminderd(app)
}

/// Whether the app uses the kit's reminders plugin.
fn uses_reminders(app: &App) -> bool {
    fs::read_to_string(app.dir.join("src-tauri/Cargo.toml")).is_ok_and(|t| t.contains("droid-kit-reminders"))
}

/// Run in the build image from the app's directory. The service is a package of
/// the kit's workspace, which the app reaches only as a dependency of the
/// reminders plugin (a git checkout of the kit's tag, or the local checkout
/// under `dk kit local`), and cargo does not build a dependency's binary
/// or accept its features from the app. So: ask cargo where the dependency's
/// manifest is, and build it there, with the kit's own Cargo.lock.
const REMINDERD_SCRIPT: &str = r#"set -e
M=$(cargo metadata --format-version 1 --manifest-path src-tauri/Cargo.toml | node -e 'const m = JSON.parse(require("fs").readFileSync(0, "utf8")); const p = m.packages.find(p => p.name === "droid-kit-reminderd"); if (!p) { console.error("droid-kit-reminderd is not a dependency of this app; is droid-kit-reminders in src-tauri/Cargo.toml?"); process.exit(1); } console.log(p.manifest_path)')
T=$(rustc -vV | sed -n 's/^host: //p')
cargo build --manifest-path "$M" --features daemon --target "$T" --locked
cp @ROOT@/target/alpine-reminderd/$T/debug/droid-kit-reminderd @ROOT@/target/alpine/debug/droid-kit-reminderd.new
mv -f @ROOT@/target/alpine/debug/droid-kit-reminderd.new @ROOT@/target/alpine/debug/droid-kit-reminderd
"#;

/// Builds the reminders service static (a musl binary that also runs on this
/// laptop's glibc host, where the notifications are delivered) and puts it next
/// to the app's binary, where the plugin looks for it (replaced by a rename, as
/// the old one may be running). Alpine's Rust links the C
/// library dynamically unless told otherwise, and `--target` keeps that flag away
/// from build scripts and proc macros, which must stay dynamic.
fn build_reminderd(app: &App) -> Result<()> {
    if !uses_reminders(app) {
        return Ok(());
    }
    let root = app.root.display();
    let script = REMINDERD_SCRIPT.replace("@ROOT@", &root.to_string());
    let mut c = Command::new("podman");
    c.args(["run", "--rm", "--security-opt", "label=disable", "--userns=keep-id"]);
    for m in mounts(app) {
        c.args(["-v", &m]);
    }
    c.args(["-v", &format!("{}:/cache", cache_dir()?)])
        .args(["-e", &format!("CARGO_TARGET_DIR={root}/target/alpine-reminderd")])
        .args(["-e", "RUSTFLAGS=-C target-feature=+crt-static"])
        .args(["-e", "HOME=/cache/home"])
        .args(["-w", &app.dir.to_string_lossy()])
        .arg(&app.linux.image)
        .args(["sh", "-c", &script]);
    run(&mut c)
}

fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

fn home() -> Result<PathBuf> {
    Ok(PathBuf::from(std::env::var("HOME").context("HOME is not set")?))
}

/// The reminders plugin works as it does for an installed app: the app's data
/// directory is the real `$XDG_DATA_HOME/<identifier>` (which the service reads),
/// and the unit goes into the real `~/.config/systemd/user`. Both are mounted at
/// their own paths. `DK_REMINDER_LAUNCHER` is a script that starts the app the way
/// `dk run` does, for a tap on a notification when the app is closed.
fn reminders_args(app: &App, base: &[String], binary: &Path) -> Result<Vec<String>> {
    let home = home()?;
    let data_home = std::env::var_os("XDG_DATA_HOME").filter(|v| !v.is_empty()).map(PathBuf::from).unwrap_or_else(|| home.join(".local/share"));
    let data = data_home.join(&app.identifier);
    let units = std::env::var_os("XDG_CONFIG_HOME").filter(|v| !v.is_empty()).map(PathBuf::from).unwrap_or_else(|| home.join(".config")).join("systemd/user");
    fs::create_dir_all(&data)?;
    fs::create_dir_all(&units)?;

    let launch_dir = PathBuf::from(cache_dir()?).join("launch");
    fs::create_dir_all(&launch_dir)?;
    let launcher = launch_dir.join(format!("{}.sh", app.identifier));

    let (data, data_home, units) = (data.display(), data_home.display(), units.display());
    let extra = vec![
        "-v".to_string(),
        format!("{data}:{data}"),
        "-e".into(),
        format!("XDG_DATA_HOME={data_home}"),
        "-v".into(),
        format!("{units}:{units}"),
        "-e".into(),
        format!("DK_SYSTEMD_USER_DIR={units}"),
        "-e".into(),
        format!("DK_REMINDER_LAUNCHER={}", launcher.display()),
    ];
    let words: Vec<String> = base.iter().chain(&extra).map(|a| shell_quote(a)).collect();
    fs::write(
        &launcher,
        format!(
            "#!/bin/sh\n# Written by `dk run linux-desktop`. The reminders service runs it as `<this> --dk-reminder <id>`.\nexec podman run --rm {} {} {} \"$@\"\n",
            words.join(" "),
            shell_quote(&app.linux.image),
            shell_quote(&binary.to_string_lossy()),
        ),
    )?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&launcher, fs::Permissions::from_mode(0o755))?;
    }
    Ok(extra)
}

/// The container's arguments that put an app on this desktop session: the
/// Wayland and session-bus sockets, and the paths of the app's workspace.
fn session_args(app: &App, runtime: &str, wayland: &str) -> Result<Vec<String>> {
    let mut a: Vec<String> = vec!["--security-opt".into(), "label=disable".into(), "--userns=keep-id".into()];
    for m in mounts(app) {
        a.extend(["-v".into(), m]);
    }
    a.extend([
        "-v".into(),
        format!("{runtime}/{wayland}:/run/dk/{wayland}"),
        "-v".into(),
        format!("{runtime}/bus:/run/dk/bus"),
        "-e".into(),
        "XDG_RUNTIME_DIR=/run/dk".into(),
        "-e".into(),
        format!("WAYLAND_DISPLAY={wayland}"),
        "-e".into(),
        "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/dk/bus".into(),
    ]);
    // DK_GDK_BACKEND=x11 runs the app under XWayland, so that X11 tools such as
    // xdotool can send it real pointer input in tests. Wayland is the default.
    let backend = std::env::var("DK_GDK_BACKEND").unwrap_or_else(|_| "wayland".into());
    a.extend(["-e".into(), format!("GDK_BACKEND={backend}")]);
    if backend == "x11" {
        let display = std::env::var("DISPLAY").context("DK_GDK_BACKEND=x11 needs DISPLAY")?;
        a.extend(["-e".into(), format!("DISPLAY={display}"), "-v".into(), "/tmp/.X11-unix:/tmp/.X11-unix".into()]);
        if let Ok(xauth) = std::env::var("XAUTHORITY") {
            a.extend(["-e".into(), "XAUTHORITY=/run/dk/xauthority".into(), "-v".into(), format!("{xauth}:/run/dk/xauthority")]);
        }
    }
    a.extend(["-e".into(), "HOME=/tmp".into()]);
    // The container has no time zone of its own and would run in UTC, so the
    // app's local times (a reminder "in 2 minutes") would not be this
    // desktop's. ICU, which WebKit uses, reads `TZ`; the rules are mounted for C code.
    if let Some(zone) = host_time_zone() {
        a.extend(["-e".into(), format!("TZ={zone}")]);
        if Path::new("/usr/share/zoneinfo").is_dir() {
            a.extend(["-v".into(), "/usr/share/zoneinfo:/usr/share/zoneinfo:ro".into()]);
        }
    }
    Ok(a)
}

/// The IANA name of this machine's time zone, from the `/etc/localtime` link.
fn host_time_zone() -> Option<String> {
    let target = fs::read_link("/etc/localtime").ok()?;
    let target = target.to_string_lossy();
    target.split_once("zoneinfo/").map(|(_, name)| name.to_string())
}

pub fn run_desktop(app: &App, timeout: u64, route: Option<&str>) -> Result<ExitCode> {
    build(app)?;
    let binary = app.root.join("target/alpine/debug").join(&app.binary);
    let runtime = std::env::var("XDG_RUNTIME_DIR").context("XDG_RUNTIME_DIR is not set; is this a desktop session?")?;
    let wayland = std::env::var("WAYLAND_DISPLAY").unwrap_or_else(|_| "wayland-0".into());
    let name = format!("dk-{}", app.name());

    let _ = output(Command::new("podman").args(["rm", "-f", &name]));
    let mut args = session_args(app, &runtime, &wayland)?;
    if uses_reminders(app) {
        // The launcher starts the app again for a tap on a notification: no start route there.
        let extra = reminders_args(app, &args, &binary)?;
        args.extend(extra);
    }
    if let Some(route) = route {
        args.extend(["-e".to_string(), format!("DK_START_ROUTE={route}")]);
    }
    let mut c = Command::new("podman");
    // No --rm: the logs must outlive a crash. The next run removes the old container.
    c.args(["run", "-d", "--name", &name]).args(&args).arg(&app.linux.image).arg(&binary);
    output(&mut c)?;

    let outcome = wait_ready(&name, timeout)?;
    let base = app.artifacts()?.join(format!("{}-linux-desktop-{}", app.name(), stamp()));
    let shot = base.with_extension("png");
    let log = base.with_extension("log");
    if matches!(outcome, Outcome::Ready(_)) {
        sleep(0.5);
        screenshot_active_window(&shot)?;
    }
    fs::write(&log, logs(&name))?;
    report(outcome, timeout, &shot, &log)
}

fn logs(name: &str) -> String {
    Command::new("podman")
        .args(["logs", name])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned() + &String::from_utf8_lossy(&o.stderr))
        .unwrap_or_default()
}

fn wait_ready(name: &str, timeout: u64) -> Result<Outcome> {
    let start = Instant::now();
    while start.elapsed().as_secs() < timeout {
        let log = logs(name);
        if let Some(line) = log.lines().find(|l| l.starts_with("DK_ERROR")) {
            return Ok(Outcome::Errored(line.to_string()));
        }
        if log.contains("DK_READY") {
            return Ok(Outcome::Ready(start.elapsed().as_secs_f64()));
        }
        let running = output(Command::new("podman").args(["inspect", "-f", "{{.State.Running}}", name]))?;
        if running.trim() != "true" {
            return Ok(Outcome::Exited);
        }
        sleep(0.5);
    }
    Ok(Outcome::TimedOut)
}

/// Captures the newly opened window, which KWin has given focus, without a prompt.
fn screenshot_active_window(path: &Path) -> Result<()> {
    run(Command::new("spectacle").args(["-b", "-n", "-a", "-o"]).arg(path))?;
    // spectacle returns before the file is written.
    for _ in 0..20 {
        if path.exists() {
            return Ok(());
        }
        sleep(0.25);
    }
    anyhow::bail!("spectacle did not write {}", path.display())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_words_are_quoted_for_the_launcher_script() {
        assert_eq!(shell_quote("plain"), "'plain'");
        assert_eq!(shell_quote("it's here"), "'it'\\''s here'");
        assert_eq!(shell_quote("a b$c"), "'a b$c'");
    }
}

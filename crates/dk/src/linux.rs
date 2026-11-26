//! The Linux desktop target: build in the Alpine (musl) image, which matches
//! postmarketOS, and run the result on this machine's Wayland session.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};
use std::time::Instant;

use anyhow::{Context, Result, bail};

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

/// Whether the app uses the kit's store plugin, which keeps its database in the app's data directory.
fn uses_store(app: &App) -> bool {
    fs::read_to_string(app.dir.join("src-tauri/Cargo.toml")).is_ok_and(|t| t.contains("droid-kit-store"))
}

/// `$XDG_DATA_HOME` (default `~/.local/share`) and the app's directory in it, `<identifier>`.
fn data_dirs(home: &Path, xdg_data_home: Option<PathBuf>, identifier: &str) -> (PathBuf, PathBuf) {
    let data_home = xdg_data_home.filter(|p| !p.as_os_str().is_empty()).unwrap_or_else(|| home.join(".local/share"));
    let data = data_home.join(identifier);
    (data_home, data)
}

/// The app's real data directory, mounted at its own path with `XDG_DATA_HOME` set, so what the
/// app keeps there (the store's database, the reminders file) survives the container.
fn data_dir_args(app: &App) -> Result<Vec<String>> {
    let (data_home, data) = data_dirs(&home()?, std::env::var_os("XDG_DATA_HOME").map(PathBuf::from), &app.identifier);
    fs::create_dir_all(&data)?;
    Ok(vec!["-v".into(), format!("{0}:{0}", data.display()), "-e".into(), format!("XDG_DATA_HOME={}", data_home.display())])
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
    let units = std::env::var_os("XDG_CONFIG_HOME").filter(|v| !v.is_empty()).map(PathBuf::from).unwrap_or_else(|| home.join(".config")).join("systemd/user");
    fs::create_dir_all(&units)?;

    let launch_dir = PathBuf::from(cache_dir()?).join("launch");
    fs::create_dir_all(&launch_dir)?;
    let launcher = launch_dir.join(format!("{}.sh", app.identifier));

    let units = units.display();
    let mut extra = data_dir_args(app)?;
    extra.extend([
        "-v".to_string(),
        format!("{units}:{units}"),
        "-e".into(),
        format!("DK_SYSTEMD_USER_DIR={units}"),
        "-e".into(),
        format!("DK_REMINDER_LAUNCHER={}", launcher.display()),
    ]);
    let words: Vec<String> = base.iter().chain(&extra).map(|a| shell_quote(a)).collect();
    fs::write(
        &launcher,
        format!(
            "#!/bin/sh\n# Written by `dk run linux-desktop`. The reminders service runs it as `<this> --dk-reminder <id>`.\nexec podman run --rm --replace --name {} {} {} {} \"$@\"\n",
            shell_quote(&format!("dk-{}", app.name())),
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

/// Where the evaluation channel's socket is on the host: `$XDG_RUNTIME_DIR/droid-kit/<identifier>/eval.sock`.
/// The directory is private (mode 0700), in the user's runtime directory, and is mounted into the container.
pub fn eval_socket(runtime: &str, identifier: &str) -> PathBuf {
    Path::new(runtime).join("droid-kit").join(identifier).join("eval.sock")
}

/// The debug-only evaluation channel (`dk test linux-desktop`): a directory shared with the
/// container, and the socket the platform plugin opens in it. A release build ignores the variable.
fn eval_args(app: &App, runtime: &str) -> Result<Vec<String>> {
    let socket = eval_socket(runtime, &app.identifier);
    let dir = socket.parent().expect("the socket has a directory");
    fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // The channel runs page code for whoever connects: only this user may.
        fs::set_permissions(dir.parent().expect("a parent"), fs::Permissions::from_mode(0o700))?;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
    }
    Ok(vec!["-v".into(), format!("{}:/run/dk/eval", dir.display()), "-e".into(), "DK_EVAL_SOCKET=/run/dk/eval/eval.sock".into()])
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
    a.extend(eval_args(app, runtime)?);
    a.extend(["-e".into(), "HOME=/tmp".into()]);
    a.extend(locale_args(|name| std::env::var(name).ok()));
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

/// The variables that choose a locale. The container has none of its own, and
/// without them WebKitGTK reports `navigator.language` as `C`, which `Intl` rejects.
const LOCALE_VARS: &[&str] = &["LC_ALL", "LC_MESSAGES", "LANGUAGE", "LANG", "LC_CTYPE", "LC_TIME", "LC_NUMERIC", "LC_COLLATE", "LC_MONETARY"];

/// `-e NAME=value` for each locale variable the host has set.
fn locale_args(get: impl Fn(&str) -> Option<String>) -> Vec<String> {
    LOCALE_VARS
        .iter()
        .filter_map(|name| get(name).filter(|v| !v.is_empty()).map(|v| ["-e".to_string(), format!("{name}={v}")]))
        .flatten()
        .collect()
}

/// The IANA name of this machine's time zone, from the `/etc/localtime` link.
fn host_time_zone() -> Option<String> {
    let target = fs::read_link("/etc/localtime").ok()?;
    let target = target.to_string_lossy();
    target.split_once("zoneinfo/").map(|(_, name)| name.to_string())
}

/// Removes the container of an earlier run, which may still be running or may
/// have crashed: both leave a container of that name behind (no `--rm`, so the
/// logs outlive a crash).
fn remove_container(name: &str) -> Result<()> {
    let exists = |name: &str| succeeds(Command::new("podman").args(["container", "exists", name]));
    if !exists(name) {
        return Ok(());
    }
    eprintln!("removing the container of an earlier run: {name}");
    let _ = output(Command::new("podman").args(["rm", "-f", "-t", "1", name]));
    for _ in 0..20 {
        if !exists(name) {
            return Ok(());
        }
        sleep(0.25);
    }
    anyhow::bail!("could not remove the container {name} of an earlier run; try `podman rm -f {name}`")
}

pub fn run_desktop(app: &App, timeout: u64, route: Option<&str>, build_first: bool) -> Result<ExitCode> {
    let name = format!("dk-{}", app.name());
    // Before the build too: a running container holds the app's binary open.
    remove_container(&name)?;
    if build_first {
        build(app)?;
    }
    let binary = app.root.join("target/alpine/debug").join(&app.binary);
    if !binary.is_file() {
        bail!("{} does not exist; run `dk run linux-desktop` without --no-build first", binary.display());
    }
    let runtime = std::env::var("XDG_RUNTIME_DIR").context("XDG_RUNTIME_DIR is not set; is this a desktop session?")?;
    let wayland = std::env::var("WAYLAND_DISPLAY").unwrap_or_else(|_| "wayland-0".into());

    let base = app.artifacts()?.join(format!("{}-linux-desktop-{}", app.name(), stamp()));
    let shot = base.with_extension("png");
    let log = base.with_extension("log");

    let mut args = session_args(app, &runtime, &wayland)?;
    if uses_reminders(app) {
        // The launcher starts the app again for a tap on a notification: no start route or screenshot there.
        let extra = reminders_args(app, &args, &binary)?;
        args.extend(extra);
    } else if uses_store(app) {
        // The reminders arguments include this; an app with only a database needs just the directory.
        args.extend(data_dir_args(app)?);
    }
    if let Some(route) = route {
        args.extend(["-e".to_string(), format!("DK_START_ROUTE={route}")]);
    }
    // The app writes the picture of its own web view when it is ready.
    // Two seconds before dk gives up it also takes one of a page that is not ready, to show where it hangs.
    args.extend(["-e".to_string(), format!("DK_SCREENSHOT={}", shot.display())]);
    args.extend(["-e".to_string(), format!("DK_SCREENSHOT_AFTER={}", timeout.saturating_sub(3).max(1))]);
    remove_container(&name)?;
    let mut c = Command::new("podman");
    // No --rm: the logs must outlive a crash. The next run removes the old container.
    // --replace: if something started a container of this name in between, it goes too.
    c.args(["run", "-d", "--replace", "--name", &name]).args(&args).arg(&app.linux.image).arg(&binary);
    output(&mut c)?;

    let outcome = wait_ready(&name, timeout)?;
    if matches!(outcome, Outcome::Ready(_) | Outcome::TimedOut) {
        wait_screenshot(&name, &shot);
    }
    fs::write(&log, logs(&name))?;
    report(outcome, timeout, &shot, &log)
}

/// Waits for the app to say it has written its screenshot. Without one the run
/// still succeeds, and says why: a missing picture beats one of another window.
fn wait_screenshot(name: &str, shot: &Path) {
    for _ in 0..40 {
        let log = logs(name);
        if let Some(line) = log.lines().find(|l| l.starts_with("DK_SCREENSHOT_FAILED")) {
            eprintln!("no screenshot: {}", line.trim_start_matches("DK_SCREENSHOT_FAILED").trim());
            return;
        }
        if log.lines().any(|l| l.starts_with("DK_SCREENSHOT ")) && shot.exists() {
            return;
        }
        sleep(0.25);
    }
    eprintln!("no screenshot: the app did not write one within 10 s (is the kit's platform plugin older than 0.1.1?)");
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_hosts_locale_goes_into_the_container() {
        let env = |name: &str| match name {
            "LANG" => Some("en_US.utf8".to_string()),
            "LC_TIME" => Some("en_GB.UTF-8".to_string()),
            "LC_ALL" => Some(String::new()),
            _ => None,
        };
        assert_eq!(locale_args(env), ["-e", "LANG=en_US.utf8", "-e", "LC_TIME=en_GB.UTF-8"]);
        assert!(locale_args(|_| None).is_empty());
    }

    #[test]
    fn the_data_directory_is_xdg_data_home_slash_identifier() {
        let home = Path::new("/home/brian");
        assert_eq!(data_dirs(home, None, "com.ortusnova.x"), (PathBuf::from("/home/brian/.local/share"), PathBuf::from("/home/brian/.local/share/com.ortusnova.x")));
        assert_eq!(data_dirs(home, Some(PathBuf::new()), "a.b").1, PathBuf::from("/home/brian/.local/share/a.b"));
        assert_eq!(data_dirs(home, Some("/data".into()), "a.b"), (PathBuf::from("/data"), PathBuf::from("/data/a.b")));
    }

    #[test]
    fn the_evaluation_socket_is_in_the_runtime_directory_under_the_identifier() {
        assert_eq!(eval_socket("/run/user/1000", "com.ortusnova.lifedroid"), PathBuf::from("/run/user/1000/droid-kit/com.ortusnova.lifedroid/eval.sock"));
    }

    #[test]
    fn shell_words_are_quoted_for_the_launcher_script() {
        assert_eq!(shell_quote("plain"), "'plain'");
        assert_eq!(shell_quote("it's here"), "'it'\\''s here'");
        assert_eq!(shell_quote("a b$c"), "'a b$c'");
    }
}

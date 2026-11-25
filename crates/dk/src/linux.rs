//! The Linux desktop target: build in the Alpine (musl) image, which matches
//! postmarketOS, and run the result on this machine's Wayland session.

use std::fs;
use std::path::Path;
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
    run(&mut c)
}

pub fn run_desktop(app: &App, timeout: u64, route: Option<&str>) -> Result<ExitCode> {
    build(app)?;
    let binary = app.root.join("target/alpine/debug").join(&app.binary);
    let runtime = std::env::var("XDG_RUNTIME_DIR").context("XDG_RUNTIME_DIR is not set; is this a desktop session?")?;
    let wayland = std::env::var("WAYLAND_DISPLAY").unwrap_or_else(|_| "wayland-0".into());
    let name = format!("dk-{}", app.name());

    let _ = output(Command::new("podman").args(["rm", "-f", &name]));
    let mut c = Command::new("podman");
    // No --rm: the logs must outlive a crash. The next run removes the old container.
    c.args(["run", "-d", "--name", &name, "--security-opt", "label=disable", "--userns=keep-id"]);
    for m in mounts(app) {
        c.args(["-v", &m]);
    }
    c.args(["-v", &format!("{runtime}/{wayland}:/run/dk/{wayland}")])
        .args(["-v", &format!("{runtime}/bus:/run/dk/bus")])
        .args(["-e", "XDG_RUNTIME_DIR=/run/dk", "-e", &format!("WAYLAND_DISPLAY={wayland}")])
        .args(["-e", "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/dk/bus"]);
    // DK_GDK_BACKEND=x11 runs the app under XWayland, so that X11 tools such as
    // xdotool can send it real pointer input in tests. Wayland is the default.
    let backend = std::env::var("DK_GDK_BACKEND").unwrap_or_else(|_| "wayland".into());
    c.args(["-e", &format!("GDK_BACKEND={backend}")]);
    if backend == "x11" {
        let display = std::env::var("DISPLAY").context("DK_GDK_BACKEND=x11 needs DISPLAY")?;
        c.args(["-e", &format!("DISPLAY={display}"), "-v", "/tmp/.X11-unix:/tmp/.X11-unix"]);
        if let Ok(xauth) = std::env::var("XAUTHORITY") {
            c.args(["-e", "XAUTHORITY=/run/dk/xauthority", "-v", &format!("{xauth}:/run/dk/xauthority")]);
        }
    }
    if let Some(route) = route {
        c.args(["-e", &format!("DK_START_ROUTE={route}")]);
    }
    c.args(["-e", "HOME=/tmp"])
        .arg(&app.linux.image)
        .arg(&binary);
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

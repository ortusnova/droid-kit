//! Android targets: build on the android-dev host, install over wireless
//! debugging, launch, and wait for the page to report its first screen.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};
use std::time::Instant;

use anyhow::{Context, Result, bail};

use crate::config::{App, stamp};
use crate::proc::{self, output, run, sleep, succeeds};

/// Paths never sent to the build host: host-specific installs and outputs.
/// The Android project in src-tauri/gen/android is synced (apps commit it), but
/// not its build outputs, Gradle state or files Tauri regenerates.
const EXCLUDES: &[&str] = &[
    "node_modules",
    "target",
    "artifacts",
    "dist",
    "apk",
    ".dk",
    "dk.local.toml",
    "src-tauri/gen/schemas",
    "src-tauri/gen/android/**/build",
    "src-tauri/gen/android/.gradle",
    "src-tauri/gen/android/.kotlin",
    "src-tauri/gen/android/.tauri",
    "src-tauri/gen/android/local.properties",
];

/// Syncs the app to the build host, builds a debug APK for `arch`, and copies it back.
pub fn build(app: &App, arch: &str) -> Result<PathBuf> {
    if app.dir.join(".dk/kit-local").exists() {
        bail!("this app uses a local kit checkout, which is not synced to the build host; run `dk kit pin` first");
    }
    let a = &app.android;
    let remote_root = format!("{}/work/{}", a.host_root, app.root_name());
    let remote_app = Path::new(&remote_root).join(app.rel_dir());

    let mut rsync = Command::new("rsync");
    rsync.args(["-a", "--delete"]);
    for e in EXCLUDES {
        rsync.arg(format!("--exclude={e}"));
    }
    rsync.arg(format!("{}/", app.root.display())).arg(format!("{}:{remote_root}/", a.host));
    run(&mut rsync)?;

    // build-apk installs only when node_modules is missing, so install first:
    // dependencies may have changed since the last build.
    run(Command::new("ssh").arg(&a.host).arg(format!(
        "cd {} && {}/bin/shell pnpm install --config.confirmModulesPurge=false",
        remote_app.display(),
        a.host_root
    )))?;
    let project = Path::new(&app.root_name()).join(app.rel_dir());
    run(Command::new("ssh").arg(&a.host).arg(format!("{}/bin/build-apk {} {arch}", a.host_root, project.display())))?;

    let name = remote_app.file_name().context("app directory has no name")?.to_string_lossy().into_owned();
    let apk_name = format!("{name}-{arch}-debug.apk");
    let local = app.artifacts()?.join(&apk_name);
    run(Command::new("scp").arg("-q").arg(format!("{}:{}/apk/{apk_name}", a.host, remote_app.display())).arg(&local))?;
    Ok(local)
}

fn adb(app: &App, serial: &str) -> Command {
    let mut c = Command::new(&app.android.adb);
    c.args(["-s", serial]);
    c
}

/// Finds the phone: the configured address, or the first wireless-debugging
/// device advertised over mDNS. Connects to it if needed.
pub fn find_phone(app: &App) -> Result<String> {
    let addr = match &app.android.phone {
        Some(p) => p.clone(),
        None => mdns_phone(&app.android.adb)?.context(
            "no phone found: turn on Wireless debugging on the phone; if this computer is not paired yet, \
             use \"Pair device with pairing code\" and run: adb pair <ip:port> <code>",
        )?,
    };
    let devices = output(Command::new(&app.android.adb).arg("devices"))?;
    if !devices.lines().any(|l| l.starts_with(&addr) && l.ends_with("device")) {
        let out = output(Command::new(&app.android.adb).args(["connect", &addr]))?;
        if !out.contains("connected") {
            bail!("adb connect {addr}: {}", out.trim());
        }
    }
    Ok(addr)
}

pub fn mdns_phone(adb: &str) -> Result<Option<String>> {
    let out = output(Command::new(adb).args(["mdns", "services"]))?;
    Ok(out
        .lines()
        .find(|l| l.contains("_adb-tls-connect._tcp"))
        .and_then(|l| l.split_whitespace().last())
        .map(str::to_string))
}

pub fn run_phone(app: &App, timeout: u64) -> Result<ExitCode> {
    let serial = find_phone(app)?;
    let apk = build(app, "aarch64")?;
    let pkg = app.android_package();

    run(adb(app, &serial).args(["install", "-r"]).arg(&apk))?;
    // A locked or sleeping phone shows nothing; wake it and lift the keyguard.
    // (This works when the phone has no PIN; otherwise unlock it by hand.)
    run(adb(app, &serial).args(["shell", "input", "keyevent", "KEYCODE_WAKEUP"]))?;
    run(adb(app, &serial).args(["shell", "wm", "dismiss-keyguard"]))?;
    run(adb(app, &serial).args(["shell", "am", "force-stop", &pkg]))?;
    run(adb(app, &serial).args(["logcat", "-c"]))?;
    run(adb(app, &serial).args(["shell", "am", "start", "-n", &format!("{pkg}/.MainActivity")]))?;

    let outcome = wait_ready(app, &serial, &pkg, timeout)?;
    let base = app.artifacts()?.join(format!("{}-android-phone-{}", app.name(), stamp()));
    let shot = base.with_extension("png");
    let log = base.with_extension("logcat.txt");
    let png = adb(app, &serial).args(["exec-out", "screencap", "-p"]).output()?.stdout;
    fs::write(&shot, png)?;
    fs::write(&log, output(adb(app, &serial).args(["logcat", "-d"]))?)?;

    report(outcome, timeout, &shot, &log)
}

pub enum Outcome {
    Ready(f64),
    Errored(String),
    Exited,
    TimedOut,
}

/// Watches logcat for the page's `DK_READY` or `DK_ERROR`, and for the process ending.
fn wait_ready(app: &App, serial: &str, pkg: &str, timeout: u64) -> Result<Outcome> {
    let start = Instant::now();
    let mut seen_pid = false;
    while start.elapsed().as_secs() < timeout {
        let console = output(adb(app, serial).args(["logcat", "-d", "-s", "Tauri/Console:*"]))?;
        if let Some(line) = console.lines().find(|l| l.contains("DK_ERROR")) {
            return Ok(Outcome::Errored(line.to_string()));
        }
        if console.contains("DK_READY") {
            return Ok(Outcome::Ready(start.elapsed().as_secs_f64()));
        }
        let running = succeeds(adb(app, serial).args(["shell", "pidof", pkg]));
        seen_pid |= running;
        if seen_pid && !running {
            return Ok(Outcome::Exited);
        }
        sleep(1.0);
    }
    Ok(Outcome::TimedOut)
}

pub fn report(outcome: Outcome, timeout: u64, shot: &Path, log: &Path) -> Result<ExitCode> {
    if shot.exists() {
        eprintln!("screenshot: {}", shot.display());
    }
    eprintln!("log: {}", log.display());
    Ok(match outcome {
        Outcome::Ready(secs) => {
            eprintln!("ready: first screen rendered {secs:.1} s after launch");
            ExitCode::SUCCESS
        }
        Outcome::Errored(line) => {
            eprintln!("failed: the page reported an error: {line}\nsee {}", log.display());
            ExitCode::from(1)
        }
        Outcome::Exited => {
            eprintln!("failed: the app exited before its first screen; see {}", log.display());
            ExitCode::from(1)
        }
        Outcome::TimedOut => {
            eprintln!("failed: no first screen within {timeout} s; see {}", log.display());
            ExitCode::from(2)
        }
    })
}

/// The emulator on the build host, through its own scripts.
pub fn run_emulator(app: &App) -> Result<ExitCode> {
    let a = &app.android;
    run(Command::new("ssh").arg(&a.host).arg(format!("{}/bin/emulator-start", a.host_root)))?;
    let apk = build(app, "x86_64")?;
    let remote_apk = format!(
        "{}/work/{}/apk/{}",
        a.host_root,
        Path::new(&app.root_name()).join(app.rel_dir()).display(),
        apk.file_name().unwrap().to_string_lossy()
    );
    let status = Command::new("ssh")
        .arg(&a.host)
        .arg(format!("{}/bin/run-apk {remote_apk} {}", a.host_root, app.android_package()))
        .status()?;
    // run-apk writes its screenshot, UI dump and logcat to logs/; bring the newest back.
    let latest = output(Command::new("ssh").arg(&a.host).arg(format!(
        "ls -t {}/logs/{}-*.png 2>/dev/null | head -1",
        a.host_root,
        app.android_package()
    )))?;
    let latest = latest.trim();
    if !latest.is_empty() {
        let stem = latest.trim_end_matches(".png");
        for ext in ["png", "logcat.txt", "ui.xml"] {
            let _ = proc::run(Command::new("scp").arg("-q").arg(format!("{}:{stem}.{ext}", a.host)).arg(app.artifacts()?));
        }
        eprintln!("artifacts: {}", app.artifacts()?.display());
    }
    Ok(match status.code() {
        Some(0) => ExitCode::SUCCESS,
        Some(2) => ExitCode::from(2),
        _ => ExitCode::from(1),
    })
}

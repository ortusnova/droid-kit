//! iPhone on USB: build on this Linux machine with xtool's iOS SDK, sign with
//! the user's Apple ID and install (scripts/ios-build.sh), then launch, wait
//! for the page to report its first screen, and save a screenshot and the log.
//! The device side uses pymobiledevice3, which needs no root.

use std::fs;
use std::io::{BufRead, BufReader};
use std::process::{Command, ExitCode, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};

use crate::android::{Outcome, report};
use crate::config::{App, stamp};
use crate::proc::{output, run};

const BUILD_SCRIPT: &str = include_str!("../../../scripts/ios-build.sh");

/// The installed bundle id: xtool installs apps signed with a free Apple ID
/// as `XTL-<team>.<identifier>`.
fn installed_bundle(app: &App) -> Result<String> {
    let apps: serde_json::Value = serde_json::from_str(&output(Command::new("pymobiledevice3").args(["apps", "list", "-t", "User"]))?)
        .context("parsing `pymobiledevice3 apps list`")?;
    let id = &app.identifier;
    apps.as_object()
        .and_then(|apps| apps.keys().find(|k| *k == id || k.ends_with(&format!(".{id}"))).cloned())
        .with_context(|| format!("{id} is not installed on the iPhone"))
}

/// Stops the app if it runs. An app started through the developer services
/// (`dvt launch`, as below) makes the next install wait forever at
/// "[Connecting] 100%" until it is stopped.
fn stop_app(bundle: &str) -> Result<()> {
    let pid = output(Command::new("pymobiledevice3").args(["developer", "dvt", "process-id-for-bundle-id", bundle]))?;
    let pid = pid.trim();
    if !pid.is_empty() && pid != "0" {
        run(Command::new("pymobiledevice3").args(["developer", "dvt", "kill", pid]))?;
    }
    Ok(())
}

pub fn run_phone(app: &App, timeout: u64) -> Result<ExitCode> {
    if let Ok(bundle) = installed_bundle(app) {
        eprintln!("stopping {bundle} before the install");
        stop_app(&bundle)?;
    }
    let script = app.dir.join(".dk/ios-build.sh");
    fs::create_dir_all(script.parent().unwrap())?;
    fs::write(&script, BUILD_SCRIPT)?;
    run(Command::new("bash").arg(&script).arg(&app.dir).arg("run"))?;

    let bundle = installed_bundle(app)?;
    eprintln!("bundle: {bundle}");
    let base = app.artifacts()?.join(format!("{}-ios-phone-{}", app.name(), stamp()));
    let shot = base.with_extension("png");
    let log = base.with_extension("syslog.txt");

    // Follow the app's log from before the launch, so DK_READY cannot be missed.
    let executable = "pymobiledevice3";
    let mut syslog = Command::new(executable)
        .args(["syslog", "live", "-pn", &process_name(app)?])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .context("starting pymobiledevice3 syslog")?;
    let (tx, rx) = mpsc::channel();
    let stdout = syslog.stdout.take().unwrap();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if tx.send(line).is_err() {
                break;
            }
        }
    });
    std::thread::sleep(Duration::from_secs(3));

    // The first launch after an install can fail while the phone is still
    // registering the app; try a few times.
    let mut launched = false;
    for _ in 0..5 {
        let status = Command::new(executable).args(["developer", "dvt", "launch", "--kill-existing", &bundle]).status()?;
        if status.success() {
            launched = true;
            break;
        }
        eprintln!("launch failed; retrying in 3 s (is the iPhone unlocked?)");
        std::thread::sleep(Duration::from_secs(3));
    }
    if !launched {
        let _ = syslog.kill();
        bail!("could not launch {bundle}: unlock the iPhone and try again");
    }

    let start = Instant::now();
    let mut lines = Vec::new();
    let outcome = loop {
        let left = Duration::from_secs(timeout).saturating_sub(start.elapsed());
        if left.is_zero() {
            break Outcome::TimedOut;
        }
        match rx.recv_timeout(left) {
            Ok(line) => {
                let found = if line.contains("DK_ERROR") {
                    Some(Outcome::Errored(line.clone()))
                } else if line.contains("DK_READY") {
                    Some(Outcome::Ready(start.elapsed().as_secs_f64()))
                } else {
                    None
                };
                lines.push(line);
                if let Some(o) = found {
                    break o;
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => break Outcome::TimedOut,
            Err(mpsc::RecvTimeoutError::Disconnected) => break Outcome::Exited,
        }
    };
    // Give the first screen a moment to settle, and keep the lines that came with it.
    std::thread::sleep(Duration::from_secs(1));
    lines.extend(rx.try_iter());
    let _ = syslog.kill();
    fs::write(&log, lines.join("\n"))?;
    let _ = run(Command::new(executable).args(["developer", "dvt", "screenshot"]).arg(&shot));
    report(outcome, timeout, &shot, &log)
}

/// The app's process name: the generated Swift package's name, the product
/// name in PascalCase (life-droid -> LifeDroid), as ios-build.sh makes it.
fn process_name(app: &App) -> Result<String> {
    let conf: serde_json::Value = serde_json::from_str(&fs::read_to_string(app.dir.join("src-tauri/tauri.conf.json"))?)?;
    let product = conf["productName"].as_str().context("tauri.conf.json has no productName")?;
    Ok(product
        .split(['-', '_', ' '])
        .filter(|w| !w.is_empty())
        .map(|w| {
            let mut c = w.chars();
            c.next().map(|f| f.to_uppercase().chain(c).collect::<String>()).unwrap_or_default()
        })
        .collect::<String>()
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .collect())
}

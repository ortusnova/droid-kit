//! `dk doctor`: what each target needs, and whether it is ready.

use std::path::Path;
use std::process::{Command, ExitCode};

use anyhow::Result;

use crate::android::mdns_phone;
use crate::config::App;
use crate::proc::{output, succeeds};

struct Report {
    missing: usize,
}

impl Report {
    fn line(&mut self, ok: bool, what: &str, detail: &str) {
        if !ok {
            self.missing += 1;
        }
        println!("  [{}] {what}: {detail}", if ok { "ready" } else { "MISSING" });
    }
}

fn version(cmd: &str, args: &[&str]) -> Option<String> {
    output(Command::new(cmd).args(args)).ok().map(|s| s.lines().next().unwrap_or("").trim().to_string())
}

pub fn run(dir: &Path) -> Result<ExitCode> {
    let app = App::load(dir)?;
    let mut r = Report { missing: 0 };

    println!("all targets");
    for (cmd, args) in [("pnpm", &["--version"][..]), ("node", &["--version"]), ("rsync", &["--version"])] {
        let v = version(cmd, args);
        r.line(v.is_some(), cmd, v.as_deref().unwrap_or("not found"));
    }

    println!("linux-desktop");
    let podman = version("podman", &["--version"]);
    r.line(podman.is_some(), "podman", podman.as_deref().unwrap_or("not found"));
    let image = succeeds(Command::new("podman").args(["image", "exists", &app.linux.image]));
    r.line(true, "build image", if image { &app.linux.image } else { "not built yet; dk run builds it" });
    let runtime = std::env::var("XDG_RUNTIME_DIR").unwrap_or_default();
    let wayland = std::env::var("WAYLAND_DISPLAY").unwrap_or_default();
    let ok = !wayland.is_empty() && Path::new(&runtime).join(&wayland).exists();
    r.line(ok, "Wayland session", if ok { &wayland } else { "no WAYLAND_DISPLAY socket" });
    let spectacle = version("spectacle", &["--version"]);
    r.line(spectacle.is_some(), "spectacle (screenshots)", spectacle.as_deref().unwrap_or("not found"));

    println!("android-phone, android-emulator");
    let a = &app.android;
    let host = succeeds(Command::new("ssh").args(["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", &a.host, "test", "-x", &format!("{}/bin/build-apk", a.host_root)]));
    r.line(host, "build host", &if host { format!("{}:{}", a.host, a.host_root) } else { format!("cannot reach {}:{}/bin/build-apk over ssh", a.host, a.host_root) });
    let adb = version(&a.adb, &["version"]);
    r.line(adb.is_some(), "adb", adb.as_deref().unwrap_or(&format!("{} not found; set [android] adb in dk.local.toml", a.adb)));

    println!("android-phone");
    let phone = match &a.phone {
        Some(p) => Some(p.clone()),
        None if adb.is_some() => mdns_phone(&a.adb).ok().flatten(),
        None => None,
    };
    match phone {
        Some(p) => r.line(true, "phone", &format!("{p} (wireless debugging)")),
        None => r.line(
            false,
            "phone",
            &format!(
                "not found. Turn on Developer options → Wireless debugging. If this computer is not paired yet, tap \
                 \"Pair device with pairing code\" and run: {} pair <ip:port> <code>",
                a.adb
            ),
        ),
    }

    println!();
    if r.missing == 0 {
        println!("everything is ready");
        Ok(ExitCode::SUCCESS)
    } else {
        println!("{} missing", r.missing);
        Ok(ExitCode::FAILURE)
    }
}

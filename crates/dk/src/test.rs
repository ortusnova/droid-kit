//! `dk test <target>`: build and start the app as `dk run` does, then run its
//! device scenarios (`tests/device/`) with `@droid-kit/devtest` and its driver
//! for the target.

use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};

use anyhow::{Context, Result, bail};
use serde_json::json;

use crate::config::{self, App};

#[derive(Clone, Copy, PartialEq, Eq, Debug, clap::ValueEnum)]
pub enum TestTarget {
    AndroidPhone,
    AndroidEmulator,
    LinuxDesktop,
    IosPhone,
}

impl TestTarget {
    pub fn name(self) -> &'static str {
        match self {
            TestTarget::AndroidPhone => "android-phone",
            TestTarget::AndroidEmulator => "android-emulator",
            TestTarget::LinuxDesktop => "linux-desktop",
            TestTarget::IosPhone => "ios-phone",
        }
    }
}

/// The scenario runner inside the app's installed `@droid-kit/devtest`.
pub fn runner(app_dir: &Path) -> Result<PathBuf> {
    let cli = app_dir.join("node_modules/@droid-kit/devtest/src/cli.js");
    if !cli.is_file() {
        bail!(
            "{} is missing: add @droid-kit/devtest to the app's devDependencies, at the same kit tag as the other kit packages, and run pnpm install",
            cli.display()
        );
    }
    Ok(cli)
}

/// What the runner and the driver receive, as JSON in `DK_TEST_CONTEXT`.
pub fn context(app: &App, target: TestTarget, run_dir: &Path, dk: &Path) -> serde_json::Value {
    json!({
        "target": target.name(),
        "appDir": app.dir,
        "identifier": app.identifier,
        "androidPackage": app.android_package(),
        "binary": app.binary,
        "artifacts": app.dir.join("artifacts"),
        "runDir": run_dir,
        "dk": dk,
        "android": {
            "adb": app.android.adb,
            "host": app.android.host,
            "hostRoot": app.android.host_root,
            "phone": app.android.phone,
        },
        "linux": { "image": app.linux.image },
    })
}

pub fn run(app_dir: &Path, target: TestTarget, only: Option<&str>, build: bool) -> Result<ExitCode> {
    let app = App::load(app_dir)?;
    let cli = runner(&app.dir)?;
    if build {
        let started = match target {
            TestTarget::AndroidPhone => crate::android::run_phone(&app, 90)?,
            TestTarget::AndroidEmulator => crate::android::run_emulator(&app)?,
            TestTarget::LinuxDesktop => crate::linux::run_desktop(&app, 90, None, true)?,
            TestTarget::IosPhone => crate::ios::run_phone(&app, 90)?,
        };
        if started != ExitCode::SUCCESS {
            eprintln!("dk test: the app did not start, so no scenarios ran");
            return Ok(started);
        }
    }
    let run_dir = app.artifacts()?.join("devtest").join(format!("{}-{}", target.name(), config::stamp()));
    let dk = std::env::current_exe().context("finding the dk executable")?;
    let status = Command::new("node")
        .arg(&cli)
        .current_dir(&app.dir)
        .env("DK_TEST_CONTEXT", context(&app, target, &run_dir, &dk).to_string())
        .env("DK_TEST_ONLY", only.unwrap_or(""))
        .status()
        .context("running node")?;
    Ok(match status.code() {
        Some(0) => ExitCode::SUCCESS,
        Some(c) => ExitCode::from(u8::try_from(c).unwrap_or(1)),
        None => ExitCode::FAILURE,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn target_names_match_dk_run_and_the_runner() {
        let names: Vec<_> = [TestTarget::AndroidPhone, TestTarget::AndroidEmulator, TestTarget::LinuxDesktop, TestTarget::IosPhone].iter().map(|t| t.name()).collect();
        assert_eq!(names, ["android-phone", "android-emulator", "linux-desktop", "ios-phone"]);
    }

    #[test]
    fn the_iphone_is_ios_phone_as_in_dk_run() {
        use clap::ValueEnum;
        assert_eq!(TestTarget::from_str("ios-phone", false), Ok(TestTarget::IosPhone));
        // The name `dk run` uses, not the platform's.
        assert!(TestTarget::from_str("ios", false).is_err());
    }

    #[test]
    fn a_missing_runner_names_the_package_to_add() {
        let dir = tempfile::tempdir().unwrap();
        let err = runner(dir.path()).unwrap_err().to_string();
        assert!(err.contains("@droid-kit/devtest"), "{err}");
    }
}

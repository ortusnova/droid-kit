//! `dk kit local` and `dk kit pin`: point an app at a local kit checkout, and
//! back at its pinned tag with every dependency file restored byte for byte.
//!
//! `local` saves the files it may change under `.dk/kit-backup/`, then adds
//! pnpm overrides (`pnpm-workspace.yaml`) and a Cargo `[patch]`
//! (`.cargo/config.toml`). `pin` puts the saved files back and deletes the
//! ones that did not exist before.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};

use anyhow::{Context, Result, bail};

use crate::check::{cargo_kit_deps, npm_kit_deps};
use crate::proc::run;

/// Files `local` may change, relative to the app's directory.
const TOUCHED: &[&str] = &["pnpm-workspace.yaml", "pnpm-lock.yaml", ".cargo/config.toml", "Cargo.lock", "src-tauri/Cargo.lock"];
const KIT_GIT: &str = "https://github.com/ortusnova/droid-kit";

fn backup_dir(app: &Path) -> PathBuf {
    app.join(".dk/kit-backup")
}

pub fn local(app: &Path, kit: &Path) -> Result<ExitCode> {
    let app = app.canonicalize()?;
    let kit = kit.canonicalize().with_context(|| format!("kit checkout {}", kit.display()))?;
    if !kit.join("packages").is_dir() || !kit.join("crates").is_dir() {
        bail!("{} does not look like a droid-kit checkout (no packages/ and crates/)", kit.display());
    }
    if backup_dir(&app).exists() {
        bail!("already using a local kit; run `dk kit pin` first");
    }

    let npm = npm_kit_deps(&fs::read_to_string(app.join("package.json")).context("reading package.json")?)?;
    let cargo = cargo_kit_deps(&fs::read_to_string(app.join("src-tauri/Cargo.toml")).context("reading src-tauri/Cargo.toml")?)?;
    if npm.is_empty() && cargo.is_empty() {
        bail!("this app has no kit dependencies to replace");
    }
    let workspace = fs::read_to_string(app.join("pnpm-workspace.yaml")).unwrap_or_default();
    if workspace.lines().any(|l| l.starts_with("overrides:")) {
        bail!("pnpm-workspace.yaml already has overrides; dk kit local cannot add its own");
    }
    if app.join(".cargo/config.toml").exists() {
        bail!(".cargo/config.toml exists; dk kit local cannot add its [patch] safely");
    }

    // Save every file we may change, and note the ones that do not exist.
    let backup = backup_dir(&app);
    fs::create_dir_all(&backup)?;
    let mut absent = String::new();
    for rel in TOUCHED {
        let src = app.join(rel);
        if src.exists() {
            let dst = backup.join(rel);
            fs::create_dir_all(dst.parent().unwrap())?;
            fs::copy(&src, &dst)?;
        } else {
            absent.push_str(rel);
            absent.push('\n');
        }
    }
    fs::write(backup.join("ABSENT"), absent)?;
    fs::write(app.join(".dk/kit-local"), kit.to_string_lossy().as_bytes())?;

    let mut overrides = String::from(if workspace.is_empty() || workspace.ends_with('\n') { "" } else { "\n" });
    overrides.push_str("overrides:\n");
    for dep in &npm {
        let pkg = dep.name.rsplit('/').next().unwrap_or(&dep.name);
        overrides.push_str(&format!("  '{}': link:{}\n", dep.name, kit.join("packages").join(pkg).display()));
    }
    fs::write(app.join("pnpm-workspace.yaml"), workspace + &overrides)?;

    let mut patch = format!("[patch.\"{KIT_GIT}\"]\n");
    for dep in &cargo {
        patch.push_str(&format!("{} = {{ path = \"{}\" }}\n", dep.name, kit.join("crates").join(&dep.name).display()));
    }
    fs::create_dir_all(app.join(".cargo"))?;
    fs::write(app.join(".cargo/config.toml"), patch)?;

    run(Command::new("pnpm").arg("install").current_dir(&app))?;
    run(Command::new("cargo").args(["metadata", "--format-version", "1", "--manifest-path", "src-tauri/Cargo.toml"]).current_dir(&app).stdout(std::process::Stdio::null()))?;
    eprintln!("using the kit at {}; `dk kit pin` goes back to the pinned tag", kit.display());
    Ok(ExitCode::SUCCESS)
}

pub fn pin(app: &Path) -> Result<ExitCode> {
    let app = app.canonicalize()?;
    let backup = backup_dir(&app);
    if !backup.exists() {
        eprintln!("already on the pinned tag");
        return Ok(ExitCode::SUCCESS);
    }
    let absent = fs::read_to_string(backup.join("ABSENT"))?;
    for rel in TOUCHED {
        let dst = app.join(rel);
        if absent.lines().any(|l| l == *rel) {
            if dst.exists() {
                fs::remove_file(&dst)?;
            }
        } else {
            fs::copy(backup.join(rel), &dst)?;
        }
    }
    let cargo_dir = app.join(".cargo");
    if cargo_dir.is_dir() && fs::read_dir(&cargo_dir)?.next().is_none() {
        fs::remove_dir(&cargo_dir)?;
    }
    fs::remove_dir_all(&backup)?;
    fs::remove_file(app.join(".dk/kit-local"))?;
    run(Command::new("pnpm").arg("install").current_dir(&app))?;
    eprintln!("back on the pinned kit tag");
    Ok(ExitCode::SUCCESS)
}

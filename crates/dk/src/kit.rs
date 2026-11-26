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
    // The linked packages resolve their own dependencies from the checkout.
    if !kit.join("node_modules").is_dir() {
        bail!("{} has no node_modules; run `pnpm install` in the kit checkout first", kit.display());
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
    if !backup_dir(&app).exists() {
        eprintln!("already on the pinned tag");
        return Ok(ExitCode::SUCCESS);
    }
    restore_files(&app)?;
    run(Command::new("pnpm").arg("install").current_dir(&app))?;
    eprintln!("back on the pinned kit tag");
    Ok(ExitCode::SUCCESS)
}

/// Puts back every file `local` saved, deletes the ones that did not exist
/// before, and removes the directories `local` made once they are empty.
fn restore_files(app: &Path) -> Result<()> {
    let backup = backup_dir(app);
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
    fs::remove_dir_all(&backup)?;
    fs::remove_file(app.join(".dk/kit-local"))?;
    // `.dk/` may hold other things, so only an empty one goes.
    for dir in [".cargo", ".dk"] {
        let dir = app.join(dir);
        if dir.is_dir() && fs::read_dir(&dir)?.next().is_none() {
            fs::remove_dir(&dir)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Lays out what `local` leaves behind, for an app that had these files before it.
    fn app_in_local_mode(root: &Path, had_cargo_config: bool) {
        let backup = backup_dir(root);
        fs::create_dir_all(backup.join("src-tauri")).unwrap();
        fs::write(root.join("pnpm-workspace.yaml"), "packages: []\noverrides:\n").unwrap();
        fs::write(backup.join("pnpm-workspace.yaml"), "packages: []\n").unwrap();
        fs::write(root.join("pnpm-lock.yaml"), "changed").unwrap();
        fs::write(backup.join("pnpm-lock.yaml"), "lock").unwrap();
        fs::write(root.join("src-tauri/Cargo.lock"), "changed").unwrap();
        fs::write(backup.join("src-tauri/Cargo.lock"), "cargo lock").unwrap();
        let mut absent = String::from("Cargo.lock\n");
        if !had_cargo_config {
            absent.push_str(".cargo/config.toml\n");
        }
        fs::write(backup.join("ABSENT"), absent).unwrap();
        fs::create_dir_all(root.join(".cargo")).unwrap();
        fs::write(root.join(".cargo/config.toml"), "[patch]").unwrap();
        fs::write(root.join(".dk/kit-local"), "/kit").unwrap();
    }

    #[test]
    fn pin_restores_files_and_leaves_no_directories_behind() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("src-tauri")).unwrap();
        fs::create_dir_all(dir.path().join(".dk")).unwrap();
        app_in_local_mode(dir.path(), false);
        restore_files(dir.path()).unwrap();
        assert_eq!(fs::read_to_string(dir.path().join("pnpm-workspace.yaml")).unwrap(), "packages: []\n");
        assert_eq!(fs::read_to_string(dir.path().join("pnpm-lock.yaml")).unwrap(), "lock");
        assert_eq!(fs::read_to_string(dir.path().join("src-tauri/Cargo.lock")).unwrap(), "cargo lock");
        assert!(!dir.path().join(".cargo").exists(), ".cargo/ is gone");
        assert!(!dir.path().join(".dk").exists(), ".dk/ is gone, not left empty");
    }

    #[test]
    fn pin_keeps_a_dk_directory_that_holds_something_else() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("src-tauri")).unwrap();
        fs::create_dir_all(dir.path().join(".dk")).unwrap();
        fs::write(dir.path().join(".dk/other"), "x").unwrap();
        app_in_local_mode(dir.path(), false);
        restore_files(dir.path()).unwrap();
        assert!(dir.path().join(".dk/other").exists());
        assert!(!dir.path().join(".dk/kit-local").exists());
    }
}

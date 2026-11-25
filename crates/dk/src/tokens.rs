//! `dk tokens apply`: bring the gallery's saved token choices into the token source.

use std::fs;
use std::path::Path;
use std::process::{Command, ExitCode};

use anyhow::{Context, Result, bail};

use crate::android::find_phone;
use crate::check::kit_root;
use crate::config::{App, stamp};
use crate::proc::{output, run};

const GALLERY: &str = "apps/gallery";

pub fn apply(dir: &Path, file: Option<&Path>) -> Result<ExitCode> {
    let root = kit_root(dir).context("dk tokens apply runs inside the kit's repository")?;
    let choices = match file {
        Some(f) => f.canonicalize()?,
        None => fetch_from_phone(&root)?,
    };
    eprintln!("choices: {}", choices.display());
    eprint!("{}", fs::read_to_string(&choices)?);
    run(Command::new("node").arg("packages/tokens/scripts/apply-choices.ts").arg(&choices).current_dir(&root))?;
    Ok(ExitCode::SUCCESS)
}

/// The gallery saves `token-choices.json` in its data directory; debug builds
/// let `run-as` read it.
fn fetch_from_phone(root: &Path) -> Result<std::path::PathBuf> {
    let app = App::load(&root.join(GALLERY))?;
    let serial = find_phone(&app)?;
    let pkg = app.android_package();
    let adb = |args: &[&str]| {
        let mut c = Command::new(&app.android.adb);
        c.args(["-s", &serial]).args(args);
        c
    };
    let found = output(&mut adb(&["shell", "run-as", &pkg, "find", ".", "-name", "token-choices.json"]))?;
    let Some(rel) = found.lines().next().map(str::trim).filter(|l| !l.is_empty()) else {
        bail!("the gallery on the phone has no saved choices yet: open Design and tap Save");
    };
    let json = output(&mut adb(&["shell", "run-as", &pkg, "cat", rel]))?;
    let dest = app.artifacts()?.join(format!("token-choices-{}.json", stamp()));
    fs::write(&dest, json)?;
    Ok(dest)
}

//! Running other programs.

use std::process::{Command, Stdio};

use anyhow::{Context, Result, bail};

fn describe(cmd: &Command) -> String {
    let mut s = cmd.get_program().to_string_lossy().into_owned();
    for a in cmd.get_args() {
        s.push(' ');
        s.push_str(&a.to_string_lossy());
    }
    s
}

/// Runs a command with its output shown, failing if it fails.
pub fn run(cmd: &mut Command) -> Result<()> {
    let what = describe(cmd);
    eprintln!("$ {what}");
    let status = cmd.status().with_context(|| format!("starting {what}"))?;
    if !status.success() {
        bail!("{what} failed ({status})");
    }
    Ok(())
}

/// Runs a command and returns its standard output, failing if it fails.
pub fn output(cmd: &mut Command) -> Result<String> {
    let what = describe(cmd);
    let out = cmd.stderr(Stdio::piped()).output().with_context(|| format!("starting {what}"))?;
    if !out.status.success() {
        bail!("{what} failed ({}): {}", out.status, String::from_utf8_lossy(&out.stderr).trim());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Runs a command quietly and reports whether it succeeded.
pub fn succeeds(cmd: &mut Command) -> bool {
    cmd.stdout(Stdio::null()).stderr(Stdio::null()).status().is_ok_and(|s| s.success())
}

pub fn sleep(secs: f64) {
    std::thread::sleep(std::time::Duration::from_secs_f64(secs));
}

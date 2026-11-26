//! `droid-kit-reminderd --app-id <id> --app-name <name> --data-dir <dir> --launcher <program>`
//!
//! A systemd user service, written to be built static for musl. See the library's `daemon` module.

use std::path::PathBuf;

use droid_kit_reminderd::daemon::{Config, run};

fn usage() -> ! {
    eprintln!("usage: droid-kit-reminderd --app-id <id> --app-name <name> --data-dir <dir> --launcher <program> [--state-dir <dir>]");
    std::process::exit(2);
}

fn state_home() -> PathBuf {
    if let Some(dir) = std::env::var_os("XDG_STATE_HOME").filter(|d| !d.is_empty()) {
        return PathBuf::from(dir);
    }
    PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".local/state")
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let (mut app_id, mut app_name, mut data_dir, mut launcher, mut state_dir) = (None, None, None, None, None);
    let mut args = std::env::args().skip(1);
    while let Some(flag) = args.next() {
        let value = args.next().unwrap_or_else(|| usage());
        match flag.as_str() {
            "--app-id" => app_id = Some(value),
            "--app-name" => app_name = Some(value),
            "--data-dir" => data_dir = Some(PathBuf::from(value)),
            "--launcher" => launcher = Some(PathBuf::from(value)),
            "--state-dir" => state_dir = Some(PathBuf::from(value)),
            _ => usage(),
        }
    }
    let (Some(app_id), Some(data_dir), Some(launcher)) = (app_id, data_dir, launcher) else { usage() };
    let config = Config {
        app_name: app_name.unwrap_or_else(|| app_id.clone()),
        state_dir: state_dir.unwrap_or_else(|| state_home().join(&app_id)),
        app_id,
        data_dir,
        launcher,
    };
    if let Err(e) = run(config).await {
        eprintln!("droid-kit-reminderd: {e}");
        std::process::exit(1);
    }
}

//! droid-kit command-line tool: build, install, launch and check apps.

mod android;
mod check;
mod config;
mod doctor;
mod kit;
mod linux;
mod proc;

use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Parser, Subcommand, ValueEnum};

#[derive(Parser)]
#[command(name = "dk", version, about = "droid-kit: build, run and check apps")]
struct Cli {
    /// The app's directory: the one with package.json, src-tauri/ and dk.toml.
    #[arg(long, global = true, default_value = ".")]
    app: PathBuf,
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// List what each target needs, and whether it is ready.
    Doctor,
    /// Build the app, install and launch it on a target, and wait for its first screen.
    Run {
        target: Target,
        /// Seconds to wait for the first screen before failing.
        #[arg(long, default_value_t = 90)]
        timeout: u64,
    },
    /// Check the app (or the kit, when run in the kit's repository).
    Check,
    /// Switch between the pinned kit tag and a local kit checkout.
    Kit {
        #[command(subcommand)]
        cmd: KitCmd,
    },
}

#[derive(Subcommand)]
enum KitCmd {
    /// Use a local kit checkout instead of the pinned tag.
    Local { path: PathBuf },
    /// Go back to the pinned tag, restoring the dependency files exactly.
    Pin,
}

#[derive(Clone, Copy, ValueEnum)]
enum Target {
    AndroidPhone,
    AndroidEmulator,
    LinuxDesktop,
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    let result = match cli.cmd {
        Cmd::Doctor => doctor::run(&cli.app),
        Cmd::Check => check::run(&cli.app),
        Cmd::Kit { cmd: KitCmd::Local { path } } => kit::local(&cli.app, &path),
        Cmd::Kit { cmd: KitCmd::Pin } => kit::pin(&cli.app),
        Cmd::Run { target, timeout } => config::App::load(&cli.app).and_then(|app| match target {
            Target::AndroidPhone => android::run_phone(&app, timeout),
            Target::AndroidEmulator => android::run_emulator(&app),
            Target::LinuxDesktop => linux::run_desktop(&app, timeout),
        }),
    };
    match result {
        Ok(code) => code,
        Err(e) => {
            eprintln!("dk: error: {e:#}");
            ExitCode::FAILURE
        }
    }
}

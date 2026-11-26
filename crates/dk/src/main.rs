//! droid-kit command-line tool: build, install, launch and check apps.

mod android;
mod check;
mod config;
mod doctor;
mod ios;
mod kit;
mod linux;
mod new;
mod proc;
mod test;
mod tokens;

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
        /// Debug builds on linux-desktop: open this route first, e.g. /components/demo.
        #[arg(long)]
        route: Option<String>,
        /// linux-desktop: start the binary that is already built, without building. For a restart.
        #[arg(long)]
        no_build: bool,
    },
    /// Build and start the app as `run` does, then run its device scenarios (tests/device/).
    Test {
        target: test::TestTarget,
        /// Run only the scenarios whose name contains this text.
        #[arg(long)]
        only: Option<String>,
        /// Use the app already running on the target: do not build, install or start it.
        #[arg(long)]
        no_build: bool,
    },
    /// Make a new app from the kit's template.
    New {
        /// The app's name: the npm package, the Rust crate and the Linux binary, e.g. life-droid.
        name: String,
        /// The application identifier, e.g. com.ortusnova.lifedroid.
        #[arg(long)]
        id: String,
        /// Where to make the app: a new or existing directory, which may hold other files
        /// but none the template would overwrite. Default: ./<name>.
        #[arg(long)]
        dir: Option<PathBuf>,
        /// The launcher label and window title. Default: the name.
        #[arg(long)]
        title: Option<String>,
        /// The kit tag to pin, e.g. v0.1.0-rc.1. Default: this dk's own version.
        #[arg(long)]
        kit_tag: Option<String>,
    },
    /// Check the app (or the kit, when run in the kit's repository).
    Check,
    /// Design tokens (run in the kit's repository).
    Tokens {
        #[command(subcommand)]
        cmd: TokensCmd,
    },
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

#[derive(Subcommand)]
enum TokensCmd {
    /// Write the choices made on the gallery's Design page into the token source.
    Apply {
        /// A choices file; by default it is fetched from the gallery on the Android phone.
        #[arg(long)]
        file: Option<PathBuf>,
    },
}

#[derive(Clone, Copy, ValueEnum)]
enum Target {
    AndroidPhone,
    AndroidEmulator,
    LinuxDesktop,
    /// An iPhone on USB, built here with xtool and signed with your Apple ID.
    IosPhone,
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    let result = match cli.cmd {
        Cmd::Doctor => doctor::run(&cli.app),
        Cmd::New { name, id, dir, title, kit_tag } => new::run(&name, &id, dir.as_deref(), title.as_deref(), kit_tag.as_deref()),
        Cmd::Check => check::run(&cli.app),
        Cmd::Kit { cmd: KitCmd::Local { path } } => kit::local(&cli.app, &path),
        Cmd::Kit { cmd: KitCmd::Pin } => kit::pin(&cli.app),
        Cmd::Tokens { cmd: TokensCmd::Apply { file } } => tokens::apply(&cli.app, file.as_deref()),
        Cmd::Test { target, only, no_build } => test::run(&cli.app, target, only.as_deref(), !no_build),
        Cmd::Run { target, timeout, route, no_build } => config::App::load(&cli.app).and_then(|app| match (target, route) {
            (Target::AndroidPhone, None) if !no_build => android::run_phone(&app, timeout),
            (Target::AndroidEmulator, None) if !no_build => android::run_emulator(&app),
            (Target::LinuxDesktop, route) => linux::run_desktop(&app, timeout, route.as_deref(), !no_build),
            (Target::IosPhone, None) if !no_build => ios::run_phone(&app, timeout),
            (_, Some(_)) => Err(anyhow::anyhow!("--route works with linux-desktop only")),
            (_, None) => Err(anyhow::anyhow!("--no-build works with linux-desktop only")),
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

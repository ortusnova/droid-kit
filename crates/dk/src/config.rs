//! An app as `dk` sees it: its directories, identity and target settings.
//!
//! Settings come from `dk.toml` (committed) and `dk.local.toml` (gitignored,
//! for device addresses and machine paths), both in the app's directory.

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use serde::Deserialize;

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct File {
    #[serde(default)]
    app: AppSection,
    #[serde(default)]
    android: AndroidSection,
    #[serde(default)]
    linux: LinuxSection,
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct AppSection {
    /// Directory synced to the Android build host, relative to the app. Default ".".
    root: Option<PathBuf>,
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct AndroidSection {
    host: Option<String>,
    host_root: Option<String>,
    adb: Option<String>,
    phone: Option<String>,
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct LinuxSection {
    image: Option<String>,
}

pub struct Android {
    /// ssh name of the build host.
    pub host: String,
    /// The android-dev environment on the build host.
    pub host_root: String,
    pub adb: String,
    /// Fixed phone address; found with mDNS when absent.
    pub phone: Option<String>,
}

pub struct Linux {
    pub image: String,
}

pub struct App {
    /// The app's directory.
    pub dir: PathBuf,
    /// The directory synced to the build host; the app's directory or an ancestor.
    pub root: PathBuf,
    /// Tauri's identifier, e.g. `com.ortusnova.lifedroid`.
    pub identifier: String,
    /// The Rust package name of src-tauri, which names the Linux binary.
    pub binary: String,
    pub android: Android,
    pub linux: Linux,
}

impl App {
    pub fn load(dir: &Path) -> Result<App> {
        let dir = dir.canonicalize().with_context(|| format!("app directory {}", dir.display()))?;
        if !dir.join("src-tauri").is_dir() {
            bail!("{} has no src-tauri/ directory; run dk from an app's directory or pass --app", dir.display());
        }
        let mut file = read_settings(&dir.join("dk.toml"))?;
        let local = read_settings(&dir.join("dk.local.toml"))?;
        // dk.local.toml overrides dk.toml field by field.
        file.app.root = local.app.root.or(file.app.root);
        file.android.host = local.android.host.or(file.android.host);
        file.android.host_root = local.android.host_root.or(file.android.host_root);
        file.android.adb = local.android.adb.or(file.android.adb);
        file.android.phone = local.android.phone.or(file.android.phone);
        file.linux.image = local.linux.image.or(file.linux.image);

        let root = dir.join(file.app.root.unwrap_or_else(|| ".".into())).canonicalize()?;
        if !dir.starts_with(&root) {
            bail!("[app] root must be the app's directory or one of its ancestors");
        }

        let conf: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(dir.join("src-tauri/tauri.conf.json")).context("reading src-tauri/tauri.conf.json")?,
        )?;
        let identifier = conf["identifier"].as_str().context("tauri.conf.json has no identifier")?.to_string();

        let cargo: toml::Table = fs::read_to_string(dir.join("src-tauri/Cargo.toml"))?.parse()?;
        let binary = cargo["package"]["name"].as_str().context("src-tauri/Cargo.toml has no package name")?.to_string();

        Ok(App {
            dir,
            root,
            identifier,
            binary,
            android: Android {
                host: file.android.host.unwrap_or_else(|| "taichi".into()),
                host_root: file.android.host_root.unwrap_or_else(|| "/opt/models/android-dev".into()),
                adb: expand_home(&file.android.adb.unwrap_or_else(|| "adb".into())),
                phone: file.android.phone,
            },
            linux: Linux { image: file.linux.image.unwrap_or_else(|| "localhost/droid-kit-linux:latest".into()) },
        })
    }

    /// Android's package name: Tauri maps `-` in the identifier to `_`.
    pub fn android_package(&self) -> String {
        self.identifier.replace('-', "_")
    }

    /// Name of the synced root on the build host, under `work/`.
    pub fn root_name(&self) -> String {
        self.root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "app".into())
    }

    /// The app's directory relative to the synced root ("" when they are the same).
    pub fn rel_dir(&self) -> PathBuf {
        self.dir.strip_prefix(&self.root).unwrap_or(Path::new("")).to_path_buf()
    }

    /// Short name used in artifact file names.
    pub fn name(&self) -> String {
        self.dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "app".into())
    }

    pub fn artifacts(&self) -> Result<PathBuf> {
        let dir = self.dir.join("artifacts");
        fs::create_dir_all(&dir)?;
        Ok(dir)
    }
}

fn read_settings(path: &Path) -> Result<File> {
    if !path.exists() {
        return Ok(File::default());
    }
    toml::from_str(&fs::read_to_string(path)?).with_context(|| format!("parsing {}", path.display()))
}

pub fn expand_home(path: &str) -> String {
    match (path.strip_prefix("~/"), std::env::var("HOME")) {
        (Some(rest), Ok(home)) => format!("{home}/{rest}"),
        _ => path.to_string(),
    }
}

/// A timestamp for artifact file names, from the local clock.
pub fn stamp() -> String {
    crate::proc::output(std::process::Command::new("date").arg("+%Y%m%d-%H%M%S"))
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|_| "now".into())
}

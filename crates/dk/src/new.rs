//! `dk new`: make an app from the kit's template.
//!
//! The template (`template/` in the kit) is embedded in this binary by
//! `build.rs`. Text files hold `__DK_…__` placeholders, in their contents and
//! in their paths; `render` fills them in. Nothing is written unless every
//! destination file is free, so an existing app is never overwritten.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use anyhow::{Context, Result, bail};

mod embedded {
    include!(concat!(env!("OUT_DIR"), "/template.rs"));
}

/// The kit tag a new app pins: this `dk`'s own version. Every kit manifest at a
/// tag has that tag's version (kit-distribution spec), and `scripts/set-version.mjs`
/// sets them all, this binary's included, so `dk` built from tag `vX.Y.Z` makes
/// apps that pin `vX.Y.Z`.
pub const KIT_TAG: &str = concat!("v", env!("CARGO_PKG_VERSION"));

pub struct Params {
    /// Package and crate name, and the Android launcher label unless `title` differs.
    pub name: String,
    pub title: String,
    /// Reverse-domain application identifier.
    pub identifier: String,
    pub kit_tag: String,
}

pub fn validate_name(name: &str) -> Result<()> {
    let ok = !name.is_empty()
        && name.starts_with(|c: char| c.is_ascii_lowercase())
        && !name.ends_with('-')
        && !name.contains("--")
        && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if !ok {
        bail!("app name {name:?} must be lowercase letters, digits and single hyphens, starting with a letter (it names the npm package, the Rust crate and the Linux binary)");
    }
    Ok(())
}

pub fn validate_identifier(id: &str) -> Result<()> {
    let segments: Vec<&str> = id.split('.').collect();
    let ok = segments.len() >= 2
        && segments.iter().all(|s| {
            s.starts_with(|c: char| c.is_ascii_lowercase())
                && s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
        });
    if !ok {
        bail!("identifier {id:?} must be a reverse-domain name such as com.ortusnova.lifedroid: at least two dot-separated parts, each lowercase letters, digits, - or _, starting with a letter");
    }
    Ok(())
}

pub fn validate_kit_tag(tag: &str) -> Result<()> {
    let Some(v) = tag.strip_prefix('v') else { bail!("kit tag {tag:?} must look like v0.1.0") };
    let (core, pre) = match v.split_once('-') {
        Some((c, p)) => (c, Some(p)),
        None => (v, None),
    };
    let parts: Vec<&str> = core.split('.').collect();
    let numbers = parts.len() == 3 && parts.iter().all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()));
    let pre_ok = pre.is_none_or(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-'));
    if !numbers || !pre_ok {
        bail!("kit tag {tag:?} must look like v0.1.0 or v0.1.0-rc.1");
    }
    Ok(())
}

fn validate_title(title: &str) -> Result<()> {
    if title.trim().is_empty() || title.chars().any(char::is_control) {
        bail!("title must be one line of text");
    }
    Ok(())
}

/// A development-server port for the app, from its identifier, so that two
/// apps on one machine rarely collide. The next port is Vite's HMR port.
fn port(identifier: &str) -> u16 {
    let mut h: u32 = 0x811c9dc5;
    for b in identifier.bytes() {
        h = (h ^ u32::from(b)).wrapping_mul(0x01000193);
    }
    5400 + (h % 590) as u16
}

/// How a value is written inside a file, by the file's kind.
fn escape(path: &str, value: &str) -> String {
    let ext = Path::new(path).extension().and_then(|e| e.to_str()).unwrap_or("");
    let string_literal = |s: &str| s.replace('\\', "\\\\").replace('"', "\\\"");
    let xml = |s: &str| s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
    match ext {
        "json" | "ts" | "tsx" | "rs" | "toml" => string_literal(value),
        // Android string resources are quoted in the template; inside quotes only " and \ need escaping.
        "xml" if path.ends_with("strings.xml") => xml(&string_literal(value)),
        "xml" | "html" => xml(value),
        _ => value.to_string(),
    }
}

/// The placeholders and their values. A value may differ by file kind (`escape`).
fn placeholders(p: &Params) -> Vec<(&'static str, String, bool)> {
    let snake = p.name.replace('-', "_");
    let package = p.identifier.replace('-', "_");
    let port = port(&p.identifier);
    // (placeholder, value, escaped by file kind)
    vec![
        ("__DK_NAME__", p.name.clone(), false),
        ("__DK_TITLE__", p.title.clone(), true),
        ("__DK_IDENTIFIER__", p.identifier.clone(), false),
        ("__DK_PACKAGE_PATH__", package.replace('.', "/"), false),
        ("__DK_PACKAGE__", package, false),
        ("__DK_SNAKE__", snake.clone(), false),
        ("__DK_LIB__", format!("{snake}_lib"), false),
        ("__DK_KIT_TAG__", p.kit_tag.clone(), false),
        ("__DK_PORT_HMR__", (port + 1).to_string(), false),
        ("__DK_PORT__", port.to_string(), false),
    ]
}

fn fill(text: &str, path: &str, values: &[(&'static str, String, bool)]) -> String {
    let mut out = text.to_string();
    for (key, value, escaped) in values {
        let value = if *escaped { escape(path, value) } else { value.clone() };
        out = out.replace(key, &value);
    }
    out
}

pub struct Rendered {
    pub path: PathBuf,
    pub executable: bool,
    pub bytes: Vec<u8>,
}

/// Every file of the new app, with placeholders filled in.
pub fn render(p: &Params) -> Result<Vec<Rendered>> {
    validate_name(&p.name)?;
    validate_identifier(&p.identifier)?;
    validate_kit_tag(&p.kit_tag)?;
    validate_title(&p.title)?;
    let values = placeholders(p);
    let mut files = Vec::new();
    for (path, executable, bytes) in embedded::FILES {
        let path = fill(path, path, &values);
        let bytes = match std::str::from_utf8(bytes) {
            Ok(text) if text.contains("__DK_") => {
                let filled = fill(text, &path, &values);
                if let Some(i) = filled.find("__DK_") {
                    let rest: String = filled[i..].chars().take_while(|c| c.is_ascii_uppercase() || *c == '_').collect();
                    bail!("template file {path} has an unknown placeholder {rest}");
                }
                filled.into_bytes()
            }
            _ => bytes.to_vec(),
        };
        files.push(Rendered { path: PathBuf::from(path), executable: *executable, bytes });
    }
    Ok(files)
}

/// Writes the files under `dir`, creating it. Fails before writing anything if
/// a file exists already.
pub fn write(dir: &Path, files: &[Rendered]) -> Result<()> {
    let existing: Vec<String> = files.iter().filter(|f| dir.join(&f.path).symlink_metadata().is_ok()).map(|f| f.path.display().to_string()).collect();
    if !existing.is_empty() {
        let more = existing.len().saturating_sub(8);
        let mut shown = existing[..existing.len() - more].join("\n  ");
        if more > 0 {
            shown.push_str(&format!("\n  … and {more} more"));
        }
        bail!("{} already has {} files the template would overwrite; nothing was written:\n  {shown}", dir.display(), existing.len());
    }
    for f in files {
        let dest = dir.join(&f.path);
        fs::create_dir_all(dest.parent().unwrap())?;
        fs::write(&dest, &f.bytes).with_context(|| format!("writing {}", dest.display()))?;
        #[cfg(unix)]
        if f.executable {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&dest, fs::Permissions::from_mode(0o755))?;
        }
    }
    Ok(())
}

pub fn run(name: &str, identifier: &str, dir: Option<&Path>, title: Option<&str>, kit_tag: Option<&str>) -> Result<ExitCode> {
    let params = Params {
        name: name.to_string(),
        title: title.unwrap_or(name).to_string(),
        identifier: identifier.to_string(),
        kit_tag: kit_tag.unwrap_or(KIT_TAG).to_string(),
    };
    let files = render(&params)?;
    let dir = dir.map(Path::to_path_buf).unwrap_or_else(|| PathBuf::from(name));
    write(&dir, &files)?;
    let shown = dir.canonicalize().unwrap_or(dir);
    eprintln!("made {} ({} files) in {}, pinned to kit {}", params.name, files.len(), shown.display(), params.kit_tag);
    eprintln!("next: cd {} && pnpm install && dk check && dk run linux-desktop", shown.display());
    Ok(ExitCode::SUCCESS)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params() -> Params {
        Params { name: "life-droid".into(), title: "life-droid".into(), identifier: "com.ortusnova.lifedroid".into(), kit_tag: "v0.1.0".into() }
    }

    fn text<'a>(files: &'a [Rendered], path: &str) -> &'a str {
        let f = files.iter().find(|f| f.path == Path::new(path)).unwrap_or_else(|| panic!("no {path}"));
        std::str::from_utf8(&f.bytes).unwrap()
    }

    #[test]
    fn fills_in_name_identifier_title_and_tag() {
        let files = render(&params()).unwrap();
        let pkg = text(&files, "package.json");
        assert!(pkg.contains(r#""name": "life-droid""#));
        assert!(pkg.contains("github:ortusnova/droid-kit#v0.1.0&path:/packages/ui"));
        let cargo = text(&files, "src-tauri/Cargo.toml");
        assert!(cargo.contains(r#"name = "life-droid""#));
        assert!(cargo.contains(r#"name = "life_droid_lib""#));
        assert!(cargo.contains(r#"droid-kit-reminders = { git = "https://github.com/ortusnova/droid-kit", tag = "v0.1.0" }"#));
        let conf = text(&files, "src-tauri/tauri.conf.json");
        assert!(conf.contains(r#""identifier": "com.ortusnova.lifedroid""#));
        assert!(conf.contains(r#""productName": "life-droid""#));
        assert!(text(&files, "src-tauri/src/main.rs").contains("life_droid_lib::run()"));
    }

    #[test]
    fn android_project_is_rewritten_including_the_kotlin_directory() {
        let files = render(&params()).unwrap();
        let gradle = text(&files, "src-tauri/gen/android/app/build.gradle.kts");
        assert!(gradle.contains(r#"namespace = "com.ortusnova.lifedroid""#));
        assert!(gradle.contains(r#"applicationId = "com.ortusnova.lifedroid""#));
        assert!(text(&files, "src-tauri/gen/android/app/src/main/java/com/ortusnova/lifedroid/MainActivity.kt").starts_with("package com.ortusnova.lifedroid\n"));
        assert!(files.iter().any(|f| f.path.starts_with("src-tauri/gen/android/buildSrc/src/main/java/com/ortusnova/lifedroid/kotlin")));
        assert!(text(&files, "src-tauri/gen/android/app/src/main/res/values/strings.xml").contains(r#"<string name="app_name">"life-droid"</string>"#));
        assert!(text(&files, "src-tauri/gen/android/app/src/main/AndroidManifest.xml").contains("@style/Theme.life_droid"));
        assert!(text(&files, "src-tauri/gen/android/app/src/main/res/values/themes.xml").contains(r#"name="Theme.life_droid""#));
        assert!(!files.iter().any(|f| f.path.to_string_lossy().contains("gallery") || f.path.to_string_lossy().contains("__DK")));
    }

    #[test]
    fn hyphens_in_the_identifier_become_underscores_in_the_android_package() {
        let mut p = params();
        p.identifier = "org.my-team.my-app".into();
        let files = render(&p).unwrap();
        assert!(text(&files, "src-tauri/gen/android/app/build.gradle.kts").contains(r#"applicationId = "org.my_team.my_app""#));
        assert!(text(&files, "src-tauri/tauri.conf.json").contains(r#""identifier": "org.my-team.my-app""#));
        assert!(files.iter().any(|f| f.path.ends_with("org/my_team/my_app/MainActivity.kt")));
    }

    #[test]
    fn a_title_is_escaped_for_each_kind_of_file() {
        let mut p = params();
        p.title = r#"Tom & "Jerry's" <app>"#.into();
        let files = render(&p).unwrap();
        let conf: serde_json::Value = serde_json::from_str(text(&files, "src-tauri/tauri.conf.json")).unwrap();
        assert_eq!(conf["productName"], p.title);
        assert!(text(&files, "src-tauri/gen/android/app/src/main/res/values/strings.xml").contains(r#""Tom &amp; \"Jerry's\" &lt;app&gt;""#));
        assert!(text(&files, "index.html").contains("<title>Tom &amp; \"Jerry's\" &lt;app&gt;</title>"));
        assert!(text(&files, "src/app-info.ts").contains(r#"title: "Tom & \"Jerry's\" <app>""#));
    }

    #[test]
    fn no_placeholder_is_left_and_binary_files_are_untouched() {
        let files = render(&params()).unwrap();
        for f in &files {
            if let Ok(t) = std::str::from_utf8(&f.bytes) {
                assert!(!t.contains("__DK_"), "{} still has a placeholder", f.path.display());
            }
        }
        let jar = files.iter().find(|f| f.path.ends_with("gradle-wrapper.jar")).unwrap();
        assert!(jar.bytes.starts_with(b"PK"));
        assert!(files.iter().find(|f| f.path.ends_with("gradlew")).unwrap().executable);
    }

    #[test]
    fn rejects_bad_input() {
        for bad in ["", "Life", "1life", "life_droid", "life--droid", "life-", "life droid"] {
            assert!(validate_name(bad).is_err(), "{bad}");
        }
        for bad in ["lifedroid", "com..x", "com.Ortus.x", "com.1x.y", "com.x y.z"] {
            assert!(validate_identifier(bad).is_err(), "{bad}");
        }
        for bad in ["0.1.0", "v0.1", "v0.1.0.1", "v0.1.x", "v0.1.0-", "main"] {
            assert!(validate_kit_tag(bad).is_err(), "{bad}");
        }
        for good in ["v0.1.0", "v0.1.0-rc.1", "v10.20.30"] {
            validate_kit_tag(good).unwrap();
        }
    }

    #[test]
    fn refuses_to_overwrite_and_writes_nothing() {
        let files = render(&params()).unwrap();
        let tmp = tempfile::tempdir().unwrap();
        // Other files may be there already.
        fs::create_dir_all(tmp.path().join("design")).unwrap();
        fs::write(tmp.path().join("design/notes.md"), "keep").unwrap();
        fs::write(tmp.path().join("package.json"), "mine").unwrap();
        let err = write(tmp.path(), &files).unwrap_err().to_string();
        assert!(err.contains("package.json") && err.contains("nothing was written"), "{err}");
        assert_eq!(fs::read_to_string(tmp.path().join("package.json")).unwrap(), "mine");
        assert!(!tmp.path().join("src-tauri").exists());

        fs::remove_file(tmp.path().join("package.json")).unwrap();
        write(tmp.path(), &files).unwrap();
        assert_eq!(fs::read_to_string(tmp.path().join("design/notes.md")).unwrap(), "keep");
        assert!(tmp.path().join("src-tauri/Cargo.toml").is_file());
    }

    #[test]
    fn the_default_tag_is_this_dks_version() {
        assert_eq!(KIT_TAG, format!("v{}", env!("CARGO_PKG_VERSION")));
        validate_kit_tag(KIT_TAG).unwrap();
    }

    #[test]
    fn ports_are_stable_and_in_range() {
        assert_eq!(port("com.ortusnova.lifedroid"), port("com.ortusnova.lifedroid"));
        assert!((5400..5990).contains(&port("a.b")));
    }
}

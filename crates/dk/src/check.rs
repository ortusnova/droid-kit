//! `dk check`: rules an app (or the kit itself) must pass.

use std::fs;
use std::path::Path;
use std::process::ExitCode;

use anyhow::{Context, Result};

const KIT_REPO: &str = "ortusnova/droid-kit";

/// A kit dependency and the tag it names.
#[derive(Debug, PartialEq)]
pub struct KitDep {
    pub name: String,
    pub tag: String,
}

/// Kit dependencies in a package.json: `github:ortusnova/droid-kit#<tag>&path:/…`.
pub fn npm_kit_deps(package_json: &str) -> Result<Vec<KitDep>> {
    let v: serde_json::Value = serde_json::from_str(package_json).context("parsing package.json")?;
    let mut deps = Vec::new();
    for section in ["dependencies", "devDependencies"] {
        if let Some(map) = v[section].as_object() {
            for (name, spec) in map {
                let Some(spec) = spec.as_str() else { continue };
                if let Some(rest) = spec.split_once(&format!("{KIT_REPO}#")).map(|(_, r)| r) {
                    let tag = rest.split('&').next().unwrap_or("").to_string();
                    deps.push(KitDep { name: name.clone(), tag });
                }
            }
        }
    }
    Ok(deps)
}

/// Kit dependencies in a Cargo.toml: `{ git = "https://github.com/ortusnova/droid-kit", tag = "…" }`.
pub fn cargo_kit_deps(cargo_toml: &str) -> Result<Vec<KitDep>> {
    let t: toml::Table = cargo_toml.parse().context("parsing Cargo.toml")?;
    let mut deps = Vec::new();
    for section in ["dependencies", "build-dependencies", "dev-dependencies"] {
        if let Some(map) = t.get(section).and_then(|s| s.as_table()) {
            for (name, spec) in map {
                let Some(spec) = spec.as_table() else { continue };
                if spec.get("git").and_then(|g| g.as_str()).is_some_and(|g| g.contains(KIT_REPO)) {
                    let tag = spec.get("tag").and_then(|t| t.as_str()).unwrap_or("(no tag)").to_string();
                    deps.push(KitDep { name: name.clone(), tag });
                }
            }
        }
    }
    Ok(deps)
}

/// Every kit dependency must name the same tag. Returns the problems found.
pub fn tag_problems(deps: &[KitDep]) -> Vec<String> {
    let mut tags: Vec<&str> = deps.iter().map(|d| d.tag.as_str()).collect();
    tags.sort();
    tags.dedup();
    if tags.len() <= 1 {
        return Vec::new();
    }
    let list = deps.iter().map(|d| format!("  {} → {}", d.name, d.tag)).collect::<Vec<_>>().join("\n");
    vec![format!("kit dependencies name {} different tags; they must all name one:\n{list}", tags.len())]
}

/// The kit's own checks, when `dk check` runs in the kit's repository.
fn kit_checks(root: &Path) -> Result<bool> {
    let mut ok = true;
    for (what, script, args) in [
        ("design tokens", "packages/tokens/scripts/generate.ts", &["--check"][..]),
        ("colour literals in components", "scripts/check-colours.mjs", &[][..]),
    ] {
        eprintln!("kit: {what}");
        let status = std::process::Command::new("node")
            .arg(script)
            .args(args)
            .current_dir(root)
            .status()
            .with_context(|| format!("running {script} (is node on PATH?)"))?;
        ok &= status.success();
    }
    Ok(ok)
}

pub fn kit_root(dir: &Path) -> Option<std::path::PathBuf> {
    let dir = dir.canonicalize().ok()?;
    dir.ancestors()
        .find(|d| d.join("crates/dk/Cargo.toml").is_file() && d.join("packages/tokens/scripts/generate.ts").is_file())
        .map(Path::to_path_buf)
}

pub fn run(dir: &Path) -> Result<ExitCode> {
    if let Some(root) = kit_root(dir) {
        if dir.canonicalize()? == root {
            return Ok(if kit_checks(&root)? { ExitCode::SUCCESS } else { ExitCode::FAILURE });
        }
    }
    let mut problems = Vec::new();
    let mut deps = Vec::new();
    if let Ok(s) = fs::read_to_string(dir.join("package.json")) {
        deps.extend(npm_kit_deps(&s)?);
    }
    if let Ok(s) = fs::read_to_string(dir.join("src-tauri/Cargo.toml")) {
        deps.extend(cargo_kit_deps(&s)?);
    }
    problems.extend(tag_problems(&deps));

    if problems.is_empty() {
        let tag = deps.first().map(|d| d.tag.as_str()).unwrap_or("none");
        eprintln!("ok: {} kit dependencies, tag {tag}", deps.len());
        Ok(ExitCode::SUCCESS)
    } else {
        for p in &problems {
            eprintln!("problem: {p}");
        }
        Ok(ExitCode::FAILURE)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PKG: &str = r#"{
        "dependencies": {
            "react": "19.3.1",
            "@droid-kit/ui": "github:ortusnova/droid-kit#v0.1.0&path:/packages/ui"
        },
        "devDependencies": { "@droid-kit/tokens": "github:ortusnova/droid-kit#v0.1.0&path:/packages/tokens" }
    }"#;

    const CARGO: &str = r#"
        [package]
        name = "app"
        [dependencies]
        tauri = "2"
        droid-kit-platform = { git = "https://github.com/ortusnova/droid-kit", tag = "v0.1.0" }
    "#;

    #[test]
    fn finds_kit_deps_on_both_sides() {
        let npm = npm_kit_deps(PKG).unwrap();
        assert_eq!(npm.len(), 2);
        assert!(npm.iter().all(|d| d.tag == "v0.1.0"));
        let cargo = cargo_kit_deps(CARGO).unwrap();
        assert_eq!(cargo, vec![KitDep { name: "droid-kit-platform".into(), tag: "v0.1.0".into() }]);
    }

    #[test]
    fn one_tag_passes() {
        let mut deps = npm_kit_deps(PKG).unwrap();
        deps.extend(cargo_kit_deps(CARGO).unwrap());
        assert!(tag_problems(&deps).is_empty());
    }

    #[test]
    fn mixed_tags_fail_and_name_each_dependency() {
        let mut deps = npm_kit_deps(PKG).unwrap();
        deps.extend(cargo_kit_deps(&CARGO.replace("v0.1.0", "v0.2.0")).unwrap());
        let problems = tag_problems(&deps);
        assert_eq!(problems.len(), 1);
        assert!(problems[0].contains("droid-kit-platform → v0.2.0"));
        assert!(problems[0].contains("@droid-kit/ui → v0.1.0"));
    }

    #[test]
    fn missing_tag_counts_as_a_different_tag() {
        let deps = cargo_kit_deps(r#"[dependencies]
            a = { git = "https://github.com/ortusnova/droid-kit", tag = "v0.1.0" }
            b = { git = "https://github.com/ortusnova/droid-kit", branch = "main" }"#)
        .unwrap();
        assert_eq!(tag_problems(&deps).len(), 1);
    }
}

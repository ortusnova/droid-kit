//! Embeds the app template (`template/` in the kit) in the `dk` binary, so an
//! installed `dk` can make an app without a checkout of the kit.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};

/// Local build output that is never part of the template.
const SKIP: &[&str] = &["node_modules", "target", "dist", "artifacts", ".dk", "schemas", "pnpm-lock.yaml", "dk.local.toml"];

fn collect(root: &Path, dir: &Path, out: &mut Vec<PathBuf>) {
    let mut entries: Vec<_> = fs::read_dir(dir).expect("reading the template").map(|e| e.unwrap().path()).collect();
    entries.sort();
    for path in entries {
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        if SKIP.contains(&name.as_str()) {
            continue;
        }
        println!("cargo:rerun-if-changed={}", path.display());
        if path.is_dir() {
            collect(root, &path, out);
        } else {
            out.push(path);
        }
    }
}

fn main() {
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let template = manifest.join("../../template").canonicalize().expect("template/ is missing from the kit");
    println!("cargo:rerun-if-changed={}", template.display());
    let mut files = Vec::new();
    collect(&template, &template, &mut files);

    let mut code = String::from("pub const FILES: &[(&str, bool, &[u8])] = &[\n");
    for path in files {
        let rel = path.strip_prefix(&template).unwrap().to_string_lossy().into_owned();
        #[cfg(unix)]
        let executable = {
            use std::os::unix::fs::PermissionsExt;
            fs::metadata(&path).unwrap().permissions().mode() & 0o111 != 0
        };
        #[cfg(not(unix))]
        let executable = false;
        code.push_str(&format!("    ({rel:?}, {executable}, include_bytes!({:?})),\n", path.display().to_string()));
    }
    code.push_str("];\n");
    fs::write(PathBuf::from(env::var("OUT_DIR").unwrap()).join("template.rs"), code).unwrap();
}

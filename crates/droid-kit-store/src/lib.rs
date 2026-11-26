//! Tauri plugin: one local SQLite database per app.
//!
//! The file is `<name>.db` in the app's data directory (Android `dataDir`,
//! Linux `$XDG_DATA_HOME/<identifier>`), opened in WAL mode with foreign keys
//! on. SQLite is compiled into the app (`rusqlite` with `bundled`), so no system
//! library is needed on Android or musl.
//!
//! One connection lives behind a mutex. Transactions are **batches**: a list of
//! statements sent in one call and run in one transaction, so nothing is ever
//! left open between two calls. Migrations are plain SQL scripts; script *n*
//! runs once, in one transaction together with `PRAGMA user_version = n`.
//!
//! The commands, `open`, `select`, `execute` and `batch`, are wrapped by the
//! `@droid-kit/store` package, which adds record conventions for later sync.

mod db;
mod error;

use std::path::PathBuf;
use std::sync::Mutex;

use serde_json::Value as Json;
use tauri::{
    AppHandle, Manager, Runtime, State,
    plugin::{Builder, TauriPlugin},
};

pub use db::{Db, Param, Row, Statement, StoreInfo, is_blank};
pub use error::StoreError;

/// The open database and its name; `None` until the app calls `open`.
#[derive(Default)]
struct Store(Mutex<Option<(String, PathBuf, Db)>>);

impl Store {
    fn with<T>(&self, run: impl FnOnce(&mut Db) -> Result<T, StoreError>) -> Result<T, StoreError> {
        let mut guard = self.0.lock().map_err(|_| StoreError::platform("the database lock is poisoned"))?;
        match guard.as_mut() {
            Some((_, _, db)) => run(db),
            None => Err(StoreError::NotOpen { message: "the store is not open; call openStore first".into() }),
        }
    }
}

/// The file name is `<name>.db`, so a name is a plain word.
fn check_name(name: &str) -> Result<(), StoreError> {
    let plain = !name.is_empty() && name.len() <= 64 && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    if plain { Ok(()) } else { Err(StoreError::invalid(format!("the database name {name:?} must be 1 to 64 letters, digits, '_' or '-'"))) }
}

/// Opens the app's database (creating it), and applies the migrations it has
/// not had. Calling it again with the same name, as a page reload does, applies
/// any that are still pending and reports the same file.
#[tauri::command]
#[specta::specta]
async fn open<R: Runtime>(app: AppHandle<R>, store: State<'_, Store>, name: String, migrations: Vec<String>) -> Result<StoreInfo, StoreError> {
    check_name(&name)?;
    let mut guard = store.0.lock().map_err(|_| StoreError::platform("the database lock is poisoned"))?;
    if let Some((open_name, path, db)) = guard.as_mut() {
        if *open_name != name {
            return Err(StoreError::invalid(format!("this app has already opened the database {open_name:?}; an app has one database")));
        }
        db.migrate(&migrations)?;
        return db.info(path);
    }
    let dir = app.path().app_data_dir().map_err(StoreError::platform)?;
    std::fs::create_dir_all(&dir).map_err(StoreError::platform)?;
    let path = dir.join(format!("{name}.db"));
    let db = Db::open(&path, &migrations)?;
    let info = db.info(&path)?;
    *guard = Some((name, path, db));
    Ok(info)
}

/// Reads rows. Each is a JSON object keyed by column name. `params` fill the `?` placeholders.
#[tauri::command]
#[specta::specta]
async fn select(store: State<'_, Store>, sql: String, params: Vec<Param>) -> Result<Vec<Row>, StoreError> {
    let params: Vec<Json> = params.into_iter().map(|p| p.0).collect();
    store.with(|db| db.select(&sql, &params)).map(|rows| rows.into_iter().map(Row).collect())
}

/// Runs one statement and returns how many rows it changed.
#[tauri::command]
#[specta::specta]
async fn execute(store: State<'_, Store>, sql: String, params: Vec<Param>) -> Result<u32, StoreError> {
    let params: Vec<Json> = params.into_iter().map(|p| p.0).collect();
    store.with(|db| db.execute(&sql, &params))
}

/// Runs the statements in one transaction: all of them, or none.
#[tauri::command]
#[specta::specta]
async fn batch(store: State<'_, Store>, statements: Vec<Statement>) -> Result<(), StoreError> {
    store.with(|db| db.batch(&statements))
}

fn specta_builder<R: Runtime>() -> tauri_specta::Builder<R> {
    tauri_specta::Builder::<R>::new()
        .plugin_name("droid-kit-store")
        .commands(tauri_specta::collect_commands![open::<tauri::Wry>, select, execute, batch])
}

/// The plugin, for Tauri's default runtime (Wry), which every droid-kit app uses:
/// tauri-specta needs the commands' runtime to be concrete.
pub fn init() -> TauriPlugin<tauri::Wry> {
    let builder = specta_builder::<tauri::Wry>();
    Builder::new("droid-kit-store")
        .invoke_handler(builder.invoke_handler())
        .setup(move |app, _api| {
            app.manage(Store::default());
            Ok(())
        })
        .build()
}

#[cfg(test)]
mod tests {
    /// Writes the TypeScript bindings into the @droid-kit/store package.
    #[test]
    fn export_bindings() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../packages/store/src/bindings.ts");
        super::specta_builder::<tauri::Wry>()
            .export(specta_typescript::Typescript::default().header("// Generated by `cargo test -p droid-kit-store`. Do not edit.\n"), path)
            .expect("export the TypeScript bindings");
    }

    #[test]
    fn database_names_are_plain_words() {
        assert!(super::check_name("life").is_ok());
        assert!(super::check_name("my-app_2").is_ok());
        for bad in ["", "../x", "a/b", "a.b", "a b", &"x".repeat(65)] {
            assert!(super::check_name(bad).is_err(), "{bad:?}");
        }
    }
}

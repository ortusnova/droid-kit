//! Tauri plugin: reminders that fire at a set local time, even while the app
//! is closed.
//!
//! The reminders an app has scheduled are kept in `reminders.json` in the
//! app's data directory, the single list `list` reads. Each platform turns
//! that list into system alarms:
//! - Android: `tauri-plugin-notification`, which schedules with AlarmManager,
//!   always allowed while idle.
//! - iOS: this plugin's Swift part, with a calendar trigger per occurrence rule.
//! - Linux: the `droid-kit-reminderd` user service (see that crate), which
//!   reads the same file.

mod model;
#[cfg(target_os = "android")]
mod android;
#[cfg(target_os = "ios")]
mod ios;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod linux;

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{
    AppHandle, Manager, Runtime,
    plugin::{Builder, TauriPlugin},
};
use tauri_specta::Event;

pub use model::{Capabilities, Reminder, ReminderError, Repeat, notification_id};

/// Sent when the user taps a reminder notification while the app is running.
#[derive(Debug, Clone, Serialize, Deserialize, Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct ReminderOpened {
    pub id: String,
}

/// State: the identifier of a reminder that opened the app and was not taken yet.
#[derive(Default)]
pub(crate) struct Opened(pub Mutex<Option<String>>);

fn store_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, ReminderError> {
    let dir = app.path().app_data_dir().map_err(ReminderError::platform)?;
    std::fs::create_dir_all(&dir).map_err(ReminderError::platform)?;
    Ok(dir.join("reminders.json"))
}

pub(crate) fn read_store<R: Runtime>(app: &AppHandle<R>) -> Result<Vec<Reminder>, ReminderError> {
    read_file(&store_path(app)?)
}

fn read_file(path: &Path) -> Result<Vec<Reminder>, ReminderError> {
    match std::fs::read_to_string(path) {
        Ok(s) => serde_json::from_str(&s).map_err(ReminderError::platform),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(ReminderError::platform(e)),
    }
}

/// Held while the list is read, changed and written, so two calls at the same
/// moment (two `schedule`s, a `schedule` and a `cancel`) neither lose a change
/// nor fight over the temporary file.
static STORE_LOCK: Mutex<()> = Mutex::new(());
static TEMP_FILES: AtomicU64 = AtomicU64::new(0);

/// Reads the list, lets `change` edit it, and writes it back, as one step.
fn update_store<R: Runtime>(app: &AppHandle<R>, change: impl FnOnce(&mut Vec<Reminder>)) -> Result<(), ReminderError> {
    update_file(&store_path(app)?, change)
}

fn update_file(path: &Path, change: impl FnOnce(&mut Vec<Reminder>)) -> Result<(), ReminderError> {
    // A call that panicked while holding the lock left the file whole (it is replaced by a rename), so go on.
    let _guard = STORE_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut list = read_file(path)?;
    change(&mut list);
    let json = serde_json::to_string_pretty(&list).map_err(ReminderError::platform)?;
    // Write and rename, because the Android receiver and the Linux service rewrite the same file.
    // The temporary name is unique to this write.
    let tmp = path.with_extension(format!("json.app.{}.{}.tmp", std::process::id(), TEMP_FILES.fetch_add(1, Ordering::Relaxed)));
    std::fs::write(&tmp, json).map_err(ReminderError::platform)?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        ReminderError::platform(e)
    })
}

/// Schedules a reminder, replacing any with the same id. Asks for the
/// notification permission the first time. `utcOffsetMinutes` is the offset
/// of a one-time reminder's local date and time (the app knows the time zone
/// rules; repeating reminders follow the device's clock).
#[tauri::command]
#[specta::specta]
async fn schedule<R: Runtime>(app: AppHandle<R>, reminder: Reminder, utc_offset_minutes: i32) -> Result<(), ReminderError> {
    reminder.validate()?;
    platform::ensure_permission(&app)?;
    platform::cancel(&app, &reminder.id)?;
    platform::schedule(&app, &reminder, utc_offset_minutes)?;
    update_store(&app, |list| model::upsert(list, reminder))?;
    platform::changed(&app)
}

/// Cancels a reminder. Cancelling an unknown id does nothing.
#[tauri::command]
#[specta::specta]
async fn cancel<R: Runtime>(app: AppHandle<R>, id: String) -> Result<(), ReminderError> {
    platform::cancel(&app, &id)?;
    update_store(&app, |list| list.retain(|r| r.id != id))?;
    platform::changed(&app)
}

/// The reminders that are scheduled.
#[tauri::command]
#[specta::specta]
async fn list<R: Runtime>(app: AppHandle<R>) -> Result<Vec<Reminder>, ReminderError> {
    read_store(&app)
}

#[tauri::command]
#[specta::specta]
async fn capabilities<R: Runtime>(app: AppHandle<R>) -> Capabilities {
    platform::capabilities(&app)
}

/// Opens the system's notification settings for this app, where the user can
/// allow notifications after refusing them. Does nothing where there is no
/// such permission (Linux).
#[tauri::command]
#[specta::specta]
async fn open_settings<R: Runtime>(app: AppHandle<R>) -> Result<(), ReminderError> {
    platform::open_settings(&app)
}

/// The id of the reminder whose notification opened the app, once. Call at
/// start-up: a tap that starts the app arrives before the page can listen.
/// `async`, because on Android it asks Kotlin (see the note in droid-kit-platform).
#[tauri::command]
#[specta::specta]
async fn take_opened<R: Runtime>(app: AppHandle<R>) -> Option<String> {
    let recorded = app.state::<Opened>().0.lock().ok().and_then(|mut slot| slot.take());
    match recorded {
        Some(id) => Some(id),
        None => platform::pending_opened(&app).await,
    }
}

#[cfg(target_os = "android")]
use android as platform;
#[cfg(target_os = "ios")]
use ios as platform;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use linux as platform;

/// Records a reminder that opened the app, and tells a running page.
pub(crate) fn opened<R: Runtime>(app: &AppHandle<R>, id: String) {
    if let Some(state) = app.try_state::<Opened>() {
        if let Ok(mut slot) = state.0.lock() {
            *slot = Some(id.clone());
        }
    }
    let _ = ReminderOpened { id }.emit(app);
}

fn specta_builder<R: Runtime>() -> tauri_specta::Builder<R> {
    tauri_specta::Builder::<R>::new()
        .plugin_name("droid-kit-reminders")
        .commands(tauri_specta::collect_commands![schedule::<tauri::Wry>, cancel::<tauri::Wry>, list::<tauri::Wry>, capabilities::<tauri::Wry>, take_opened::<tauri::Wry>, open_settings::<tauri::Wry>])
        .events(tauri_specta::collect_events![ReminderOpened])
}

/// The plugin, for Tauri's default runtime (Wry), which every droid-kit app uses:
/// tauri-specta needs the commands' runtime to be concrete.
pub fn init() -> TauriPlugin<tauri::Wry> {
    let builder = specta_builder::<tauri::Wry>();
    Builder::new("droid-kit-reminders")
        .invoke_handler(builder.invoke_handler())
        .setup(move |app, api| {
            builder.mount_events(app);
            app.manage(Opened::default());
            platform::setup(app, api)?;
            Ok(())
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Repeat;

    fn reminder(id: &str) -> Reminder {
        Reminder { id: id.into(), title: "t".into(), body: "b".into(), repeat: Repeat::Daily { time: "07:00".into() } }
    }

    /// Two `schedule` or `cancel` calls at the same moment used to fail (they renamed the same temporary file)
    /// or lose a change (each read the list before the other had written it).
    #[test]
    fn simultaneous_changes_all_succeed_and_none_is_lost() {
        let dir = std::env::temp_dir().join(format!("dk-reminders-store-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("reminders.json");
        let _ = std::fs::remove_file(&path);

        let threads: Vec<_> = (0..32)
            .map(|n| {
                let path = path.clone();
                std::thread::spawn(move || update_file(&path, |list| model::upsert(list, reminder(&format!("r{n}")))))
            })
            .collect();
        for t in threads {
            t.join().unwrap().expect("each simultaneous schedule succeeds");
        }
        assert_eq!(read_file(&path).unwrap().len(), 32);

        // Cancels at the same moment as schedules.
        let threads: Vec<_> = (0..32)
            .map(|n| {
                let path = path.clone();
                std::thread::spawn(move || {
                    if n % 2 == 0 { update_file(&path, |list| list.retain(|r| r.id != format!("r{n}"))) } else { update_file(&path, |list| model::upsert(list, reminder(&format!("s{n}")))) }
                })
            })
            .collect();
        for t in threads {
            t.join().unwrap().expect("each simultaneous call succeeds");
        }
        let mut ids: Vec<_> = read_file(&path).unwrap().into_iter().map(|r| r.id).collect();
        ids.sort();
        let mut expected: Vec<String> = (0..32).filter(|n| n % 2 == 1).flat_map(|n| [format!("r{n}"), format!("s{n}")]).collect();
        expected.sort();
        assert_eq!(ids, expected);
        let leftovers = std::fs::read_dir(&dir).unwrap().filter(|e| e.as_ref().unwrap().file_name() != "reminders.json").count();
        assert_eq!(leftovers, 0, "no temporary file is left behind");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// Writes the TypeScript bindings into the @droid-kit/reminders package.
    #[test]
    fn export_bindings() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../packages/reminders/src/bindings.ts");
        super::specta_builder::<tauri::Wry>()
            .export(specta_typescript::Typescript::default().header("// Generated by `cargo test -p droid-kit-reminders`. Do not edit.\n"), path)
            .expect("export the TypeScript bindings");
    }
}

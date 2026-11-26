//! Tauri plugin: reminders that fire at a set local time, even while the app
//! is closed.
//!
//! The reminders an app has scheduled are kept in `reminders.json` in the
//! app's data directory, the single list `list` reads. Each platform turns
//! that list into system alarms:
//! - Android: `tauri-plugin-notification`, which schedules with AlarmManager,
//!   always allowed while idle.
//! - Linux: the `droid-kit-reminderd` user service (see that crate), which
//!   reads the same file.

mod model;
#[cfg(target_os = "android")]
mod android;
#[cfg(not(target_os = "android"))]
mod linux;

use std::path::PathBuf;
use std::sync::Mutex;

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
    match std::fs::read_to_string(store_path(app)?) {
        Ok(s) => serde_json::from_str(&s).map_err(ReminderError::platform),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(ReminderError::platform(e)),
    }
}

fn write_store<R: Runtime>(app: &AppHandle<R>, list: &[Reminder]) -> Result<(), ReminderError> {
    let json = serde_json::to_string_pretty(list).map_err(ReminderError::platform)?;
    let path = store_path(app)?;
    // Write and rename, because the Android receiver and the Linux service
    // rewrite the same file.
    let tmp = path.with_extension("json.app.tmp");
    std::fs::write(&tmp, json).map_err(ReminderError::platform)?;
    std::fs::rename(&tmp, &path).map_err(ReminderError::platform)
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
    let mut list = read_store(&app)?;
    model::upsert(&mut list, reminder);
    write_store(&app, &list)?;
    platform::changed(&app)
}

/// Cancels a reminder. Cancelling an unknown id does nothing.
#[tauri::command]
#[specta::specta]
async fn cancel<R: Runtime>(app: AppHandle<R>, id: String) -> Result<(), ReminderError> {
    platform::cancel(&app, &id)?;
    let mut list = read_store(&app)?;
    list.retain(|r| r.id != id);
    write_store(&app, &list)?;
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

/// The id of the reminder whose notification opened the app, once. Call at
/// start-up: a tap that starts the app arrives before the page can listen.
#[tauri::command]
#[specta::specta]
fn take_opened<R: Runtime>(app: AppHandle<R>, opened: tauri::State<'_, Opened>) -> Option<String> {
    let recorded = opened.0.lock().ok().and_then(|mut slot| slot.take());
    recorded.or_else(|| platform::pending_opened(&app))
}

#[cfg(target_os = "android")]
use android as platform;
#[cfg(not(target_os = "android"))]
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
        .commands(tauri_specta::collect_commands![schedule::<tauri::Wry>, cancel::<tauri::Wry>, list::<tauri::Wry>, capabilities::<tauri::Wry>, take_opened::<tauri::Wry>])
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
    /// Writes the TypeScript bindings into the @droid-kit/reminders package.
    #[test]
    fn export_bindings() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../packages/reminders/src/bindings.ts");
        super::specta_builder::<tauri::Wry>()
            .export(specta_typescript::Typescript::default().header("// Generated by `cargo test -p droid-kit-reminders`. Do not edit.\n"), path)
            .expect("export the TypeScript bindings");
    }
}

//! iOS: reminders are scheduled by this plugin's Swift part
//! (ios/Sources/RemindersPlugin.swift): a calendar trigger for each
//! occurrence rule, evaluated on the device's calendar and clock.
//! tauri-plugin-notification is used only to ask for the notification
//! permission (its own scheduling cannot take a date from Rust on iOS: the
//! Swift side parses only JavaScript's `toISOString` format).

use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Manager, Runtime,
    plugin::{PluginApi, PluginHandle},
};
use tauri_plugin_notification::{NotificationExt, PermissionState};

use crate::model::{Capabilities, Reminder, ReminderError};

tauri::ios_plugin_binding!(init_plugin_droid_kit_reminders);

struct Swift<R: Runtime>(PluginHandle<R>);

fn swift<R: Runtime>(app: &AppHandle<R>) -> Result<tauri::State<'_, Swift<R>>, ReminderError> {
    app.try_state::<Swift<R>>().ok_or_else(|| ReminderError::platform("reminders plugin not set up"))
}

pub fn setup<R: Runtime>(app: &AppHandle<R>, api: PluginApi<R, ()>) -> Result<(), Box<dyn std::error::Error>> {
    app.manage(Swift(api.register_ios_plugin(init_plugin_droid_kit_reminders)?));
    // Tell the Swift part where reminders.json is, which also arms the next occurrences of the rules made of
    // one-time triggers. Not awaited here: setup runs on the main thread, and Swift may answer from it.
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let Ok(store) = crate::store_path(&app) else { return };
        let Ok(swift) = swift(&app) else { return };
        let _ = swift.0.run_mobile_plugin_async::<()>("configure", ConfigureArgs { store: store.to_string_lossy().into_owned() }).await;
    });
    Ok(())
}

pub fn ensure_permission<R: Runtime>(app: &AppHandle<R>) -> Result<(), ReminderError> {
    let n = app.notification();
    let state = match n.permission_state().map_err(ReminderError::platform)? {
        PermissionState::Granted => return Ok(()),
        PermissionState::Denied => PermissionState::Denied,
        _ => n.request_permission().map_err(ReminderError::platform)?,
    };
    if state == PermissionState::Granted { Ok(()) } else { Err(ReminderError::PermissionDenied) }
}

#[derive(Serialize)]
struct ScheduleArgs {
    reminder: String,
    /// Where reminders.json is: the rules to arm again come from it.
    store: String,
}

#[derive(Serialize)]
struct ConfigureArgs {
    store: String,
}

#[derive(Serialize)]
struct CancelArgs<'a> {
    id: &'a str,
}

pub fn schedule<R: Runtime>(app: &AppHandle<R>, reminder: &Reminder, _utc_offset_minutes: i32) -> Result<(), ReminderError> {
    // The device's calendar turns the local date and time into an instant, so the offset is not needed here.
    let reminder = serde_json::to_string(reminder).map_err(ReminderError::platform)?;
    let store = crate::store_path(app)?.to_string_lossy().into_owned();
    swift(app)?.0.run_mobile_plugin::<()>("schedule", ScheduleArgs { reminder, store }).map_err(ReminderError::platform)
}

pub fn cancel<R: Runtime>(app: &AppHandle<R>, reminder_id: &str) -> Result<(), ReminderError> {
    swift(app)?.0.run_mobile_plugin::<()>("cancel", CancelArgs { id: reminder_id }).map_err(ReminderError::platform)
}

/// Opens this app's notification settings (Swift `openSettings`).
pub fn open_settings<R: Runtime>(app: &AppHandle<R>) -> Result<(), ReminderError> {
    swift(app)?.0.run_mobile_plugin::<()>("openSettings", ()).map_err(ReminderError::platform)
}

pub fn changed<R: Runtime>(_app: &AppHandle<R>) -> Result<(), ReminderError> {
    Ok(())
}

#[derive(Deserialize)]
struct Tapped {
    id: Option<String>,
}

/// The reminder whose notification started the app, once (cold start). Taps
/// while the app runs arrive as the Swift plugin's `tapped` event. Async, as
/// on Android: a command that calls into the native part must not hold Tauri's
/// plugin store lock while it waits.
pub async fn pending_opened<R: Runtime>(app: &AppHandle<R>) -> Option<String> {
    swift(app).ok()?.0.run_mobile_plugin_async::<Tapped>("takeTapped", ()).await.ok()?.id
}

pub fn capabilities<R: Runtime>(_app: &AppHandle<R>) -> Capabilities {
    Capabilities { platform: "ios".into(), can_wake: true }
}

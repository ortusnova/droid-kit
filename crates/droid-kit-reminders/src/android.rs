//! Android: reminder alarms are scheduled by this plugin's Kotlin part
//! (android/src/main/java/Reminders.kt): an exact alarm allowed while idle
//! for every occurrence, each repeat computed on the device's calendar,
//! re-armed after a reboot or a clock or time-zone change.
//! tauri-plugin-notification is used only to ask for the notification
//! permission.

use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Manager, Runtime,
    plugin::{PluginApi, PluginHandle},
};
use tauri_plugin_notification::{NotificationExt, PermissionState};

use crate::model::{Capabilities, Reminder, ReminderError};

struct Kotlin<R: Runtime>(PluginHandle<R>);

fn kotlin<R: Runtime>(app: &AppHandle<R>) -> Result<tauri::State<'_, Kotlin<R>>, ReminderError> {
    app.try_state::<Kotlin<R>>().ok_or_else(|| ReminderError::platform("reminders plugin not set up"))
}

pub fn setup<R: Runtime>(app: &AppHandle<R>, api: PluginApi<R, ()>) -> Result<(), Box<dyn std::error::Error>> {
    app.manage(Kotlin(api.register_android_plugin("com.ortusnova.droidkit.reminders", "ReminderTapPlugin")?));
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
}

#[derive(Serialize)]
struct CancelArgs<'a> {
    id: &'a str,
}

pub fn schedule<R: Runtime>(app: &AppHandle<R>, reminder: &Reminder, _utc_offset_minutes: i32) -> Result<(), ReminderError> {
    // The device's calendar turns the local date and time into an instant, so the offset is not needed here.
    let reminder = serde_json::to_string(reminder).map_err(ReminderError::platform)?;
    kotlin(app)?.0.run_mobile_plugin::<()>("schedule", ScheduleArgs { reminder }).map_err(ReminderError::platform)
}

pub fn cancel<R: Runtime>(app: &AppHandle<R>, reminder_id: &str) -> Result<(), ReminderError> {
    kotlin(app)?.0.run_mobile_plugin::<()>("cancel", CancelArgs { id: reminder_id }).map_err(ReminderError::platform)
}

pub fn changed<R: Runtime>(_app: &AppHandle<R>) -> Result<(), ReminderError> {
    Ok(())
}

#[derive(Deserialize)]
struct Tapped {
    id: Option<String>,
}

/// The reminder whose notification started the app, once (cold start). Taps
/// while the app runs arrive as the Kotlin plugin's `tapped` event.
pub fn pending_opened<R: Runtime>(app: &AppHandle<R>) -> Option<String> {
    kotlin(app).ok()?.0.run_mobile_plugin::<Tapped>("takeTapped", ()).ok()?.id
}

pub fn capabilities<R: Runtime>(_app: &AppHandle<R>) -> Capabilities {
    Capabilities { platform: "android".into(), can_wake: true }
}

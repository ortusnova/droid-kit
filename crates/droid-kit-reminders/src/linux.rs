//! Linux: the reminders file is the schedule; the `droid-kit-reminderd` user
//! service reads it and delivers the notifications (task 6.6). Until the
//! service is connected, scheduling only records the reminder.

use tauri::{AppHandle, Runtime, plugin::PluginApi};

use crate::model::{Capabilities, Reminder, ReminderError};

pub fn setup<R: Runtime>(_app: &AppHandle<R>, _api: PluginApi<R, ()>) -> Result<(), Box<dyn std::error::Error>> {
    Ok(())
}

pub fn ensure_permission<R: Runtime>(_app: &AppHandle<R>) -> Result<(), ReminderError> {
    Ok(())
}

pub fn schedule<R: Runtime>(_app: &AppHandle<R>, _reminder: &Reminder, _utc_offset_minutes: i32) -> Result<(), ReminderError> {
    Ok(())
}

pub fn cancel<R: Runtime>(_app: &AppHandle<R>, _reminder_id: &str) -> Result<(), ReminderError> {
    Ok(())
}

pub fn changed<R: Runtime>(_app: &AppHandle<R>) -> Result<(), ReminderError> {
    Ok(())
}

pub fn pending_opened<R: Runtime>(_app: &AppHandle<R>) -> Option<String> {
    None
}

pub fn capabilities<R: Runtime>(_app: &AppHandle<R>) -> Capabilities {
    Capabilities { platform: "linux".into(), can_wake: false }
}

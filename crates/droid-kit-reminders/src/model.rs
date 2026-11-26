//! The reminder model shared by every platform, and the rules a reminder must follow.

use serde::{Deserialize, Serialize};
use specta::Type;

/// A reminder: shown as a system notification at a local wall-clock time.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Reminder {
    /// Chosen by the app. Scheduling with an existing id replaces that reminder.
    pub id: String,
    pub title: String,
    pub body: String,
    pub repeat: Repeat,
}

/// When a reminder fires. Times are local wall-clock times, `HH:MM`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Repeat {
    /// Once, on `date` (`YYYY-MM-DD`) at `time`.
    #[serde(rename_all = "camelCase")]
    Once { date: String, time: String },
    /// Every day at `time`.
    Daily { time: String },
    /// On each of `weekdays` (ISO: 1 = Monday … 7 = Sunday) at `time`.
    Weekly { weekdays: Vec<u8>, time: String },
}

/// What this platform can do.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub platform: String,
    /// Whether a reminder due while the device sleeps wakes it on time.
    /// When false, it is delivered as soon as the device next wakes.
    pub can_wake: bool,
}

/// Why scheduling failed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type, thiserror::Error)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ReminderError {
    /// The user refused the notification permission. The app can send them to the system setting.
    #[error("permission denied")]
    PermissionDenied,
    #[error("invalid reminder: {message}")]
    Invalid { message: String },
    #[error("{message}")]
    Platform { message: String },
}

impl ReminderError {
    pub fn platform(e: impl std::fmt::Display) -> Self {
        ReminderError::Platform { message: e.to_string() }
    }
    fn invalid(message: impl Into<String>) -> Self {
        ReminderError::Invalid { message: message.into() }
    }
}

/// `HH:MM` as (hour, minute).
pub fn parse_time(s: &str) -> Result<(u8, u8), ReminderError> {
    let (h, m) = s.split_once(':').ok_or_else(|| ReminderError::invalid(format!("time {s:?} is not HH:MM")))?;
    let h: u8 = h.parse().map_err(|_| ReminderError::invalid(format!("hour in {s:?}")))?;
    let m: u8 = m.parse().map_err(|_| ReminderError::invalid(format!("minute in {s:?}")))?;
    if h > 23 || m > 59 {
        return Err(ReminderError::invalid(format!("time {s:?} is out of range")));
    }
    Ok((h, m))
}

/// `YYYY-MM-DD` as (year, month, day).
pub fn parse_date(s: &str) -> Result<(i32, u8, u8), ReminderError> {
    let mut parts = s.split('-');
    let mut next = |what: &str| parts.next().and_then(|p| p.parse::<i32>().ok()).ok_or_else(|| ReminderError::invalid(format!("{what} in date {s:?}")));
    let (y, m, d) = (next("year")?, next("month")?, next("day")?);
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return Err(ReminderError::invalid(format!("date {s:?} is out of range")));
    }
    Ok((y, m as u8, d as u8))
}

impl Reminder {
    pub fn validate(&self) -> Result<(), ReminderError> {
        if self.id.is_empty() {
            return Err(ReminderError::invalid("id is empty"));
        }
        match &self.repeat {
            Repeat::Once { date, time } => {
                parse_date(date)?;
                parse_time(time)?;
            }
            Repeat::Daily { time } => {
                parse_time(time)?;
            }
            Repeat::Weekly { weekdays, time } => {
                parse_time(time)?;
                if weekdays.is_empty() || weekdays.iter().any(|d| !(1..=7).contains(d)) {
                    return Err(ReminderError::invalid("weekdays must be 1 (Monday) to 7 (Sunday), at least one"));
                }
            }
        }
        Ok(())
    }
}

/// Replaces the reminder with the same id, or adds it.
pub fn upsert(list: &mut Vec<Reminder>, reminder: Reminder) {
    match list.iter_mut().find(|r| r.id == reminder.id) {
        Some(existing) => *existing = reminder,
        None => list.push(reminder),
    }
}

/// A stable positive notification id for a reminder, and for each weekday of a weekly one.
pub fn notification_id(reminder_id: &str, slot: u8) -> i32 {
    // FNV-1a, so the id is the same in every build and on every run.
    let mut hash: u32 = 0x811c9dc5;
    for b in reminder_id.bytes().chain([b'#', slot]) {
        hash ^= b as u32;
        hash = hash.wrapping_mul(0x01000193);
    }
    (hash & 0x7fff_ffff) as i32
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(id: &str, repeat: Repeat) -> Reminder {
        Reminder { id: id.into(), title: "t".into(), body: "b".into(), repeat }
    }

    #[test]
    fn scheduling_an_existing_id_replaces_it() {
        let mut list = vec![r("habit-run", Repeat::Daily { time: "06:30".into() })];
        upsert(&mut list, r("habit-run", Repeat::Daily { time: "06:45".into() }));
        assert_eq!(list, vec![r("habit-run", Repeat::Daily { time: "06:45".into() })]);
        upsert(&mut list, r("habit-read", Repeat::Daily { time: "13:00".into() }));
        assert_eq!(list.len(), 2);
    }

    #[test]
    fn repeat_rules_validate() {
        assert!(r("a", Repeat::Weekly { weekdays: vec![1, 4], time: "07:00".into() }).validate().is_ok());
        assert!(r("a", Repeat::Weekly { weekdays: vec![], time: "07:00".into() }).validate().is_err());
        assert!(r("a", Repeat::Weekly { weekdays: vec![8], time: "07:00".into() }).validate().is_err());
        assert!(r("a", Repeat::Daily { time: "24:00".into() }).validate().is_err());
        assert!(r("a", Repeat::Once { date: "2026-13-01".into(), time: "07:00".into() }).validate().is_err());
        assert!(r("a", Repeat::Once { date: "2026-11-26".into(), time: "07:00".into() }).validate().is_ok());
        assert!(r("", Repeat::Daily { time: "07:00".into() }).validate().is_err());
    }

    #[test]
    fn serialized_shape_is_what_the_app_sends() {
        let json = serde_json::to_value(r("x", Repeat::Weekly { weekdays: vec![1], time: "07:00".into() })).unwrap();
        assert_eq!(json["repeat"], serde_json::json!({ "kind": "weekly", "weekdays": [1], "time": "07:00" }));
        let err = serde_json::to_value(ReminderError::PermissionDenied).unwrap();
        assert_eq!(err, serde_json::json!({ "kind": "permission-denied" }));
    }

    #[test]
    fn notification_ids_are_stable_and_distinct() {
        assert_eq!(notification_id("habit-run", 0), notification_id("habit-run", 0));
        assert_ne!(notification_id("habit-run", 1), notification_id("habit-run", 2));
        assert!(notification_id("habit-run", 7) >= 0);
    }
}

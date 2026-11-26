//! The schedule file the app writes: `reminders.json` in the app's data
//! directory. The shape is the one `droid-kit-reminders` serializes (its
//! `model.rs`); this copy keeps the service free of Tauri.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Reminder {
    pub id: String,
    pub title: String,
    pub body: String,
    pub repeat: Repeat,
}

/// Times are local wall-clock times, `HH:MM`; dates `YYYY-MM-DD`; weekdays ISO (1 = Monday).
/// A monthly day is 1 to 31 and falls on the month's last day in a shorter month,
/// so 31 means "the last day"; a yearly 29 February falls on 28 February in other years.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Repeat {
    #[serde(rename_all = "camelCase")]
    Once { date: String, time: String },
    Daily { time: String },
    Weekly { weekdays: Vec<u8>, time: String },
    Monthly { day: u8, time: String },
    Yearly { month: u8, day: u8, time: String },
}

/// What was read from `reminders.json`: the reminders this service understands,
/// and one line for each entry it does not (a rule kind from a newer kit, say).
#[derive(Debug, Default)]
pub struct Schedule {
    pub reminders: Vec<Reminder>,
    pub skipped: Vec<String>,
}

/// Reads the file entry by entry, so one entry this version cannot read does not
/// hide the others. The text as a whole must still be a JSON array.
pub fn parse_schedule_report(text: &str) -> Result<Schedule, String> {
    let entries: Vec<serde_json::Value> = serde_json::from_str(text).map_err(|e| format!("reminders.json: {e}"))?;
    let mut schedule = Schedule::default();
    for (n, entry) in entries.into_iter().enumerate() {
        let name = entry.get("id").and_then(|v| v.as_str()).map(|id| format!("{id:?}")).unwrap_or_else(|| format!("#{}", n + 1));
        match serde_json::from_value::<Reminder>(entry) {
            Ok(r) => schedule.reminders.push(r),
            Err(e) => schedule.skipped.push(format!("{name}: {e}")),
        }
    }
    Ok(schedule)
}

/// The reminders this service understands; see `parse_schedule_report`.
pub fn parse_schedule(text: &str) -> Result<Vec<Reminder>, String> {
    parse_schedule_report(text).map(|s| s.reminders)
}

impl Repeat {
    /// Changes whenever the reminder's time rule changes, so a replaced
    /// reminder starts again from now instead of inheriting what was delivered.
    pub fn fingerprint(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_what_the_plugin_writes() {
        // The plugin writes `serde_json::to_string_pretty(&Vec<Reminder>)`.
        let json = r#"[
          { "id": "test-once", "title": "t", "body": "b", "repeat": { "kind": "once", "date": "2026-11-25", "time": "18:30" } },
          { "id": "d", "title": "t", "body": "b", "repeat": { "kind": "daily", "time": "06:30" } },
          { "id": "w", "title": "t", "body": "b", "repeat": { "kind": "weekly", "weekdays": [1, 4], "time": "07:00" } }
        ]"#;
        let list = parse_schedule(json).unwrap();
        assert_eq!(list.len(), 3);
        assert_eq!(list[0].repeat, Repeat::Once { date: "2026-11-25".into(), time: "18:30".into() });
        assert_eq!(list[2].repeat, Repeat::Weekly { weekdays: vec![1, 4], time: "07:00".into() });
        assert_eq!(serde_json::to_value(&list[0].repeat).unwrap()["kind"], "once");
    }

    #[test]
    fn monthly_and_yearly_are_read() {
        let json = r#"[
          { "id": "m", "title": "t", "body": "b", "repeat": { "kind": "monthly", "day": 31, "time": "09:00" } },
          { "id": "y", "title": "t", "body": "b", "repeat": { "kind": "yearly", "month": 2, "day": 29, "time": "08:00" } }
        ]"#;
        let list = parse_schedule(json).unwrap();
        assert_eq!(list[0].repeat, Repeat::Monthly { day: 31, time: "09:00".into() });
        assert_eq!(list[1].repeat, Repeat::Yearly { month: 2, day: 29, time: "08:00".into() });
    }

    #[test]
    fn an_entry_of_an_unknown_kind_is_skipped_and_the_rest_is_kept() {
        let json = r#"[
          { "id": "a", "title": "t", "body": "b", "repeat": { "kind": "daily", "time": "06:30" } },
          { "id": "future", "title": "t", "body": "b", "repeat": { "kind": "fortnightly", "time": "06:30" } },
          { "id": "b", "title": "t", "body": "b", "repeat": { "kind": "monthly", "day": 1, "time": "06:30" } },
          { "title": "no id" }
        ]"#;
        let schedule = parse_schedule_report(json).unwrap();
        assert_eq!(schedule.reminders.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), ["a", "b"]);
        assert_eq!(schedule.skipped.len(), 2);
        assert!(schedule.skipped[0].starts_with("\"future\": "), "{:?}", schedule.skipped);
        assert!(schedule.skipped[1].starts_with("#4: "), "{:?}", schedule.skipped);
        assert_eq!(parse_schedule(json).unwrap().len(), 2);
    }

    #[test]
    fn the_fingerprint_follows_every_field_of_the_new_rules() {
        let m = |day, time: &str| Repeat::Monthly { day, time: time.into() }.fingerprint();
        assert_ne!(m(1, "06:30"), m(2, "06:30"));
        assert_ne!(m(1, "06:30"), m(1, "06:45"));
        let y = |month, day| Repeat::Yearly { month, day, time: "08:00".into() }.fingerprint();
        assert_ne!(y(2, 29), y(2, 28));
        assert_ne!(y(2, 29), y(3, 29));
        assert_ne!(m(1, "08:00"), Repeat::Daily { time: "08:00".into() }.fingerprint());
    }

    #[test]
    fn an_empty_or_broken_file_is_reported() {
        assert_eq!(parse_schedule("[]").unwrap().len(), 0);
        assert!(parse_schedule("[{").is_err());
    }
}

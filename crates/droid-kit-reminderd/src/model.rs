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
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Repeat {
    #[serde(rename_all = "camelCase")]
    Once { date: String, time: String },
    Daily { time: String },
    Weekly { weekdays: Vec<u8>, time: String },
}

pub fn parse_schedule(text: &str) -> Result<Vec<Reminder>, String> {
    serde_json::from_str(text).map_err(|e| format!("reminders.json: {e}"))
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
    fn an_empty_or_broken_file_is_reported() {
        assert_eq!(parse_schedule("[]").unwrap().len(), 0);
        assert!(parse_schedule("[{").is_err());
    }
}

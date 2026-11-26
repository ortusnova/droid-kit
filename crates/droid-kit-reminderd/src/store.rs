//! The service's one write to the schedule file: taking a delivered one-time
//! reminder out of `reminders.json`, as the Android receiver does, so the app's
//! `list` stops showing it.
//!
//! The app writes the same file (`reminders.json.app.tmp`, then rename). To
//! leave its changes alone, the file is read again just before writing, only the
//! delivered reminders are removed, and if the file changed while the new text
//! was being prepared the whole step is repeated. The new text goes to
//! `reminders.json.reminderd.tmp` first and is renamed into place.

use std::io;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use crate::model::{Reminder, Repeat, parse_schedule};

const ATTEMPTS: usize = 5;

/// Our own temporary name, next to the file.
pub fn temp_path(path: &Path) -> PathBuf {
    path.with_extension("json.reminderd.tmp")
}

fn stamp(path: &Path) -> Option<(SystemTime, u64)> {
    let meta = std::fs::metadata(path).ok()?;
    Some((meta.modified().ok()?, meta.len()))
}

/// Removes the delivered one-time reminders. A reminder is removed only if the
/// file still holds that id with the same time: one the app replaced since is a
/// new reminder and stays. Returns how many were removed. Nothing is written when none were.
pub fn remove_delivered(path: &Path, delivered: &[Reminder]) -> io::Result<usize> {
    remove_delivered_with(path, delivered, || {})
}

fn remove_delivered_with(path: &Path, delivered: &[Reminder], mut before_rename: impl FnMut()) -> io::Result<usize> {
    for _ in 0..ATTEMPTS {
        let text = match std::fs::read_to_string(path) {
            Ok(text) => text,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(0),
            Err(e) => return Err(e),
        };
        let seen = stamp(path);
        let list = parse_schedule(&text).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
        let kept: Vec<&Reminder> = list.iter().filter(|r| !delivered.iter().any(|d| is_same_once(d, r))).collect();
        let removed = list.len() - kept.len();
        if removed == 0 {
            return Ok(0);
        }
        let json = serde_json::to_string_pretty(&kept).map_err(io::Error::other)?;
        let tmp = temp_path(path);
        std::fs::write(&tmp, json)?;
        before_rename();
        if stamp(path) != seen {
            // The app wrote in the meantime: start again from its version.
            let _ = std::fs::remove_file(&tmp);
            continue;
        }
        std::fs::rename(&tmp, path)?;
        return Ok(removed);
    }
    Err(io::Error::other("reminders.json kept changing"))
}

fn is_same_once(delivered: &Reminder, in_file: &Reminder) -> bool {
    matches!(delivered.repeat, Repeat::Once { .. }) && delivered.id == in_file.id && delivered.repeat == in_file.repeat
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Dir(PathBuf);
    impl Dir {
        fn new(name: &str) -> Dir {
            let dir = std::env::temp_dir().join(format!("dk-reminderd-{}-{name}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            Dir(dir)
        }
        fn file(&self) -> PathBuf {
            self.0.join("reminders.json")
        }
    }
    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn once(id: &str, time: &str) -> Reminder {
        Reminder { id: id.into(), title: "t".into(), body: "b".into(), repeat: Repeat::Once { date: "2026-11-25".into(), time: time.into() } }
    }
    fn daily(id: &str) -> Reminder {
        Reminder { id: id.into(), title: "t".into(), body: "b".into(), repeat: Repeat::Daily { time: "06:30".into() } }
    }
    fn write(path: &Path, list: &[Reminder]) {
        std::fs::write(path, serde_json::to_string_pretty(list).unwrap()).unwrap();
    }
    fn ids(path: &Path) -> Vec<String> {
        parse_schedule(&std::fs::read_to_string(path).unwrap()).unwrap().into_iter().map(|r| r.id).collect()
    }

    #[test]
    fn removes_only_the_delivered_one_time_reminder() {
        let dir = Dir::new("only");
        write(&dir.file(), &[once("a", "18:30"), daily("d"), once("b", "19:00")]);
        assert_eq!(remove_delivered(&dir.file(), &[once("a", "18:30")]).unwrap(), 1);
        assert_eq!(ids(&dir.file()), vec!["d", "b"]);
        assert!(!temp_path(&dir.file()).exists(), "the temporary file is renamed away");
    }

    #[test]
    fn a_daily_is_never_removed() {
        let dir = Dir::new("daily");
        write(&dir.file(), &[daily("d")]);
        assert_eq!(remove_delivered(&dir.file(), &[daily("d")]).unwrap(), 0);
        assert_eq!(ids(&dir.file()), vec!["d"]);
    }

    #[test]
    fn a_reminder_the_app_replaced_meanwhile_stays() {
        let dir = Dir::new("replaced");
        write(&dir.file(), &[once("a", "19:45")]);
        assert_eq!(remove_delivered(&dir.file(), &[once("a", "18:30")]).unwrap(), 0);
        assert_eq!(ids(&dir.file()), vec!["a"]);
    }

    #[test]
    fn nothing_is_written_when_nothing_matches() {
        let dir = Dir::new("untouched");
        write(&dir.file(), &[daily("d")]);
        let before = stamp(&dir.file());
        remove_delivered(&dir.file(), &[once("gone", "18:30")]).unwrap();
        assert_eq!(stamp(&dir.file()), before);
        assert!(!temp_path(&dir.file()).exists());
        assert_eq!(remove_delivered(&dir.join_missing(), &[once("a", "18:30")]).unwrap(), 0);
    }

    #[test]
    fn a_write_by_the_app_in_the_middle_is_not_lost() {
        let dir = Dir::new("race");
        write(&dir.file(), &[once("a", "18:30"), daily("d")]);
        let path = dir.file();
        let mut interfered = false;
        let removed = remove_delivered_with(&path, &[once("a", "18:30")], || {
            if !interfered {
                interfered = true;
                // The app schedules another reminder (its own temporary name, then rename).
                let app_tmp = path.with_extension("json.app.tmp");
                std::fs::write(&app_tmp, serde_json::to_string_pretty(&[once("a", "18:30"), daily("d"), daily("new")]).unwrap()).unwrap();
                std::fs::rename(&app_tmp, &path).unwrap();
            }
        })
        .unwrap();
        assert_eq!(removed, 1);
        assert_eq!(ids(&path), vec!["d", "new"], "the app's new reminder survives and the delivered one is gone");
    }

    #[test]
    fn the_service_uses_its_own_temporary_name() {
        assert_eq!(temp_path(Path::new("/data/app/reminders.json")), Path::new("/data/app/reminders.json.reminderd.tmp"));
    }

    impl Dir {
        fn join_missing(&self) -> PathBuf {
            self.0.join("missing.json")
        }
    }
}

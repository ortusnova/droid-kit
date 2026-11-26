//! When a reminder is due, in local wall-clock time.
//!
//! A reminder's time is a civil time (`06:30`), not an instant. Each
//! occurrence is that civil time on a civil date, turned into an instant with
//! the time zone's rules at that date. So a daily 06:30 stays at 06:30 across
//! a daylight-saving change, and follows the device if its time zone changes.
//! A civil time that does not exist (the hour skipped when the clocks go
//! forward) is shifted forward by the length of the gap; one that happens twice
//! (when the clocks go back) is the first of the two.

use jiff::civil::{Date, Time};
use jiff::tz::TimeZone;
use jiff::{SignedDuration, Timestamp};

use crate::model::Repeat;

const DAY: i64 = 86_400;

fn parse_time(s: &str) -> Result<Time, String> {
    let (h, m) = s.split_once(':').ok_or_else(|| format!("time {s:?} is not HH:MM"))?;
    let h: i8 = h.parse().map_err(|_| format!("hour in {s:?}"))?;
    let m: i8 = m.parse().map_err(|_| format!("minute in {s:?}"))?;
    Time::new(h, m, 0, 0).map_err(|e| format!("time {s:?}: {e}"))
}

fn parse_date(s: &str) -> Result<Date, String> {
    let mut p = s.split('-');
    let mut next = |what: &str| p.next().and_then(|x| x.parse::<i16>().ok()).ok_or_else(|| format!("{what} in date {s:?}"));
    let (y, m, d) = (next("year")?, next("month")?, next("day")?);
    Date::new(y, m as i8, d as i8).map_err(|e| format!("date {s:?}: {e}"))
}

fn instant(tz: &TimeZone, date: Date, time: Time) -> Result<Timestamp, String> {
    tz.to_ambiguous_timestamp(date.to_datetime(time)).compatible().map_err(|e| e.to_string())
}

/// The first occurrence strictly after `after`, if there is one.
pub fn next_after(repeat: &Repeat, after: Timestamp, tz: &TimeZone) -> Result<Option<Timestamp>, String> {
    match repeat {
        Repeat::Once { date, time } => {
            let at = instant(tz, parse_date(date)?, parse_time(time)?)?;
            Ok((at > after).then_some(at))
        }
        Repeat::Daily { time } => first_matching_day(after, tz, parse_time(time)?, |_| true),
        Repeat::Weekly { weekdays, time } => {
            let time = parse_time(time)?;
            first_matching_day(after, tz, time, |d| weekdays.contains(&(d.weekday().to_monday_one_offset() as u8)))
        }
    }
}

/// Scans civil days from the day before `after`'s local date: a time zone
/// change can put an occurrence of the previous civil day after `after`.
fn first_matching_day(after: Timestamp, tz: &TimeZone, time: Time, matches: impl Fn(Date) -> bool) -> Result<Option<Timestamp>, String> {
    let mut day = tz.to_datetime(after).date().yesterday().map_err(|e| e.to_string())?;
    // A week (weekly reminders) plus a day on each side.
    for _ in 0..10 {
        if matches(day) {
            let at = instant(tz, day, time)?;
            if at > after {
                return Ok(Some(at));
            }
        }
        day = day.tomorrow().map_err(|e| e.to_string())?;
    }
    Ok(None)
}

/// The latest occurrence in `(after, upto]`: the one to deliver when several
/// passed while nothing was running or the device slept.
pub fn latest_in(repeat: &Repeat, after: Timestamp, upto: Timestamp, tz: &TimeZone) -> Result<Option<Timestamp>, String> {
    // Repeats are at most a week apart, so earlier ones never matter.
    let floor = upto.checked_sub(SignedDuration::from_secs(9 * DAY)).map_err(|e| e.to_string())?;
    let mut cursor = after.max(floor);
    let mut last = None;
    for _ in 0..16 {
        match next_after(repeat, cursor, tz)? {
            Some(t) if t <= upto => {
                last = Some(t);
                cursor = t;
            }
            _ => break,
        }
    }
    Ok(last)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tz(name: &str) -> TimeZone {
        TimeZone::get(name).unwrap()
    }
    fn ts(s: &str) -> Timestamp {
        s.parse().unwrap()
    }
    fn local(t: Timestamp, z: &TimeZone) -> String {
        let dt = z.to_datetime(t);
        let off = z.to_offset(t);
        format!("{} {}", dt.strftime("%Y-%m-%d %H:%M"), off)
    }
    fn daily(t: &str) -> Repeat {
        Repeat::Daily { time: t.into() }
    }

    #[test]
    fn daily_keeps_wall_clock_time_when_daylight_saving_ends() {
        // Denver ends daylight saving at 2026-11-01 02:00 MDT, so that day is 25 hours long.
        let denver = tz("America/Denver");
        let r = daily("06:30");
        let before = ts("2026-10-31T13:00:00Z"); // 07:00 MDT, after the 06:30 of 31 October
        let first = next_after(&r, before, &denver).unwrap().unwrap();
        assert_eq!(local(first, &denver), "2026-11-01 06:30 -07");
        assert_eq!(first, ts("2026-11-01T13:30:00Z"));
        let second = next_after(&r, first, &denver).unwrap().unwrap();
        assert_eq!(local(second, &denver), "2026-11-02 06:30 -07");
        // 06:30 MDT on 31 October is 12:30Z; 06:30 MST on 1 November is 13:30Z: 25 hours.
        let previous = ts("2026-10-31T12:30:00Z");
        assert_eq!(first.as_second() - previous.as_second(), 25 * 3600);
    }

    #[test]
    fn daily_keeps_wall_clock_time_when_daylight_saving_starts() {
        // Denver starts daylight saving at 2026-03-08 02:00 MST, so that day is 23 hours long.
        let denver = tz("America/Denver");
        let r = daily("06:30");
        let after = ts("2026-03-07T13:31:00Z"); // 06:31 MST on 7 March
        let next = next_after(&r, after, &denver).unwrap().unwrap();
        assert_eq!(local(next, &denver), "2026-03-08 06:30 -06");
        assert_eq!(next.as_second() - ts("2026-03-07T13:30:00Z").as_second(), 23 * 3600);
    }

    #[test]
    fn a_time_inside_the_skipped_hour_moves_forward_and_one_in_the_repeated_hour_is_the_first() {
        let denver = tz("America/Denver");
        // 02:30 does not exist on 8 March 2026: the clocks jump from 02:00 to 03:00.
        let skipped = next_after(&daily("02:30"), ts("2026-03-08T00:00:00Z"), &denver).unwrap().unwrap();
        assert_eq!(local(skipped, &denver), "2026-03-08 03:30 -06");
        // 01:30 happens twice on 1 November 2026 (MDT, then MST): the first.
        let twice = next_after(&daily("01:30"), ts("2026-11-01T00:00:00Z"), &denver).unwrap().unwrap();
        assert_eq!(local(twice, &denver), "2026-11-01 01:30 -06");
        assert_eq!(twice, ts("2026-11-01T07:30:00Z")); // 01:30 MDT, UTC-6
    }

    #[test]
    fn weekly_uses_the_listed_weekdays_only() {
        let utc = tz("UTC");
        let r = Repeat::Weekly { weekdays: vec![1, 4], time: "07:00".into() }; // Monday and Thursday
        // 2026-11-25 is a Wednesday.
        let thu = next_after(&r, ts("2026-11-25T12:00:00Z"), &utc).unwrap().unwrap();
        assert_eq!(thu, ts("2026-11-26T07:00:00Z"));
        let mon = next_after(&r, thu, &utc).unwrap().unwrap();
        assert_eq!(mon, ts("2026-11-30T07:00:00Z"));
        let none = Repeat::Weekly { weekdays: vec![], time: "07:00".into() };
        assert_eq!(next_after(&none, ts("2026-11-25T12:00:00Z"), &utc).unwrap(), None);
    }

    #[test]
    fn once_fires_one_time_only() {
        let denver = tz("America/Denver");
        let r = Repeat::Once { date: "2026-11-25".into(), time: "18:30".into() };
        let at = next_after(&r, ts("2026-11-26T00:00:00Z"), &denver).unwrap().unwrap();
        assert_eq!(at, ts("2026-11-26T01:30:00Z"));
        assert_eq!(next_after(&r, at, &denver).unwrap(), None);
    }

    #[test]
    fn the_same_wall_clock_time_follows_a_time_zone_change() {
        let r = daily("06:30");
        let after = ts("2026-11-25T00:00:00Z");
        let denver = next_after(&r, after, &tz("America/Denver")).unwrap().unwrap();
        let berlin = next_after(&r, after, &tz("Europe/Berlin")).unwrap().unwrap();
        assert_eq!(denver, ts("2026-11-25T13:30:00Z"));
        assert_eq!(berlin, ts("2026-11-25T05:30:00Z"));
    }

    #[test]
    fn latest_in_picks_the_newest_missed_occurrence() {
        let utc = tz("UTC");
        let r = daily("06:30");
        // Three occurrences passed (23rd, 24th, 25th at 06:30): only the 25th is delivered.
        let got = latest_in(&r, ts("2026-11-22T20:00:00Z"), ts("2026-11-25T09:00:00Z"), &utc).unwrap();
        assert_eq!(got, Some(ts("2026-11-25T06:30:00Z")));
        // Nothing passed since the last check.
        assert_eq!(latest_in(&r, ts("2026-11-25T06:30:00Z"), ts("2026-11-25T09:00:00Z"), &utc).unwrap(), None);
        // The occurrence exactly at `upto` counts, the one exactly at `after` does not.
        assert_eq!(latest_in(&r, ts("2026-11-25T06:29:59Z"), ts("2026-11-25T06:30:00Z"), &utc).unwrap(), Some(ts("2026-11-25T06:30:00Z")));
    }

    #[test]
    fn bad_times_are_errors() {
        let utc = tz("UTC");
        assert!(next_after(&daily("25:00"), ts("2026-11-25T00:00:00Z"), &utc).is_err());
        assert!(next_after(&Repeat::Once { date: "2026-13-01".into(), time: "10:00".into() }, ts("2026-11-25T00:00:00Z"), &utc).is_err());
    }
}

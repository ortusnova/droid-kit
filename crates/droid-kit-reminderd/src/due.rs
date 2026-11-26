//! When a reminder is due, in local wall-clock time.
//!
//! A reminder's time is a civil time (`06:30`), not an instant. Each
//! occurrence is that civil time on a civil date, turned into an instant with
//! the time zone's rules at that date. So a daily 06:30 stays at 06:30 across
//! a daylight-saving change, and follows the device if its time zone changes.
//! A civil time that does not exist (the hour skipped when the clocks go
//! forward) is shifted forward by the length of the gap; one that happens twice
//! (when the clocks go back) is the first of the two.
//!
//! A monthly day past the end of a shorter month is that month's last day (so
//! 31 is "the last day"), and a yearly 29 February is 28 February in years
//! without one.

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
        Repeat::Monthly { day, time } => {
            if !(1..=31).contains(day) {
                return Err(format!("monthly day {day} is not 1 to 31"));
            }
            first_matching_month(after, tz, parse_time(time)?, |y, m| clamped(y, m, *day).map(Some))
        }
        Repeat::Yearly { month, day, time } => {
            if !(1..=12).contains(month) || !(1..=31).contains(day) {
                return Err(format!("yearly {month}-{day} is not a day of the year"));
            }
            let month = *month as i8;
            first_matching_month(after, tz, parse_time(time)?, |y, m| if m == month { clamped(y, m, *day).map(Some) } else { Ok(None) })
        }
    }
}

/// `day` of the month `year`-`month`, or its last day if the month is shorter.
fn clamped(year: i16, month: i8, day: u8) -> Result<Date, String> {
    let first = Date::new(year, month, 1).map_err(|e| e.to_string())?;
    Date::new(year, month, (day as i8).min(first.days_in_month())).map_err(|e| e.to_string())
}

/// Scans civil months from the one holding the day before `after`'s local date
/// (a time zone change can put an occurrence of an earlier civil day after
/// `after`). `pick` gives the month's date, or none if the month has no
/// occurrence. 15 months cover a yearly rule.
fn first_matching_month(after: Timestamp, tz: &TimeZone, time: Time, pick: impl Fn(i16, i8) -> Result<Option<Date>, String>) -> Result<Option<Timestamp>, String> {
    let start = tz.to_datetime(after).date().yesterday().map_err(|e| e.to_string())?;
    let (mut year, mut month) = (start.year(), start.month());
    for _ in 0..15 {
        if let Some(date) = pick(year, month)? {
            let at = instant(tz, date, time)?;
            if at > after {
                return Ok(Some(at));
            }
        }
        if month == 12 {
            (year, month) = (year + 1, 1);
        } else {
            month += 1;
        }
    }
    Ok(None)
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
    // Earlier occurrences than the longest gap of the rule never matter: only the newest is delivered.
    let lookback = match repeat {
        Repeat::Monthly { .. } => 35,
        Repeat::Yearly { .. } => 370,
        _ => 9,
    };
    let floor = upto.checked_sub(SignedDuration::from_secs(lookback * DAY)).map_err(|e| e.to_string())?;
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

    fn monthly(day: u8, time: &str) -> Repeat {
        Repeat::Monthly { day, time: time.into() }
    }
    fn yearly(month: u8, day: u8, time: &str) -> Repeat {
        Repeat::Yearly { month, day, time: time.into() }
    }
    /// The next `n` occurrences after `from`, as local text.
    fn next_n(r: &Repeat, from: &str, z: &TimeZone, n: usize) -> Vec<String> {
        let mut at = ts(from);
        let mut out = Vec::new();
        for _ in 0..n {
            at = next_after(r, at, z).unwrap().unwrap();
            out.push(local(at, z));
        }
        out
    }

    #[test]
    fn monthly_on_the_31st_is_the_last_day_of_every_month() {
        // Scheduled on 1 November 2026 (09:00 UTC is the start: nothing yet today).
        let utc = tz("UTC");
        let got = next_n(&monthly(31, "09:00"), "2026-11-01T00:00:00Z", &utc, 6);
        assert_eq!(
            got,
            ["2026-11-30 09:00 +00", "2026-12-31 09:00 +00", "2027-01-31 09:00 +00", "2027-02-28 09:00 +00", "2027-03-31 09:00 +00", "2027-04-30 09:00 +00"]
        );
        // A leap year's February has its 29th.
        assert_eq!(next_n(&monthly(31, "09:00"), "2028-02-01T00:00:00Z", &utc, 1), ["2028-02-29 09:00 +00"]);
    }

    #[test]
    fn monthly_on_the_30th_and_29th_fall_back_in_february() {
        let utc = tz("UTC");
        assert_eq!(next_n(&monthly(30, "09:00"), "2027-01-31T10:00:00Z", &utc, 2), ["2027-02-28 09:00 +00", "2027-03-30 09:00 +00"]);
        assert_eq!(next_n(&monthly(29, "09:00"), "2027-01-31T10:00:00Z", &utc, 1), ["2027-02-28 09:00 +00"]);
        assert_eq!(next_n(&monthly(29, "09:00"), "2028-01-31T10:00:00Z", &utc, 1), ["2028-02-29 09:00 +00"]);
        // On the day itself, after the time, the next one is next month; before the time, it is today.
        assert_eq!(next_n(&monthly(15, "09:00"), "2026-11-15T08:59:59Z", &utc, 1), ["2026-11-15 09:00 +00"]);
        assert_eq!(next_n(&monthly(15, "09:00"), "2026-11-15T09:00:00Z", &utc, 1), ["2026-12-15 09:00 +00"]);
        // A new year.
        assert_eq!(next_n(&monthly(15, "09:00"), "2026-12-20T00:00:00Z", &utc, 1), ["2027-01-15 09:00 +00"]);
    }

    #[test]
    fn monthly_day_1_at_0630_keeps_the_wall_clock_across_the_end_of_daylight_saving() {
        // Denver: 1 October is MDT (-06), 1 November is MST (-07, the clocks went back on the 1st at 02:00), 1 December MST.
        let denver = tz("America/Denver");
        let r = monthly(1, "06:30");
        let after_oct = ts("2026-10-01T13:00:00Z"); // 07:00 MDT, after October's 06:30
        let got = next_n(&r, "2026-10-01T13:00:00Z", &denver, 3);
        assert_eq!(got, ["2026-11-01 06:30 -07", "2026-12-01 06:30 -07", "2027-01-01 06:30 -07"]);
        let nov = next_after(&r, after_oct, &denver).unwrap().unwrap();
        assert_eq!(nov, ts("2026-11-01T13:30:00Z"));
        // Scheduled on 31 October (MDT): the next one is 1 November 06:30 on the new offset.
        assert_eq!(next_n(&r, "2026-10-31T20:00:00Z", &denver, 1), ["2026-11-01 06:30 -07"]);
        // And the 1st of the month the clocks go forward: 8 March is the second Sunday, 1 March is plain MST.
        assert_eq!(next_n(&r, "2027-02-01T20:00:00Z", &denver, 2), ["2027-03-01 06:30 -07", "2027-04-01 06:30 -06"]);
    }

    #[test]
    fn yearly_on_29_february_is_28_february_in_other_years() {
        let utc = tz("UTC");
        let got = next_n(&yearly(2, 29, "08:00"), "2026-11-26T00:00:00Z", &utc, 4);
        assert_eq!(got, ["2027-02-28 08:00 +00", "2028-02-29 08:00 +00", "2029-02-28 08:00 +00", "2030-02-28 08:00 +00"]);
    }

    #[test]
    fn yearly_on_an_ordinary_date() {
        let utc = tz("UTC");
        assert_eq!(next_n(&yearly(3, 15, "08:00"), "2026-11-26T00:00:00Z", &utc, 2), ["2027-03-15 08:00 +00", "2028-03-15 08:00 +00"]);
        // Today before the time is today; at the time it is next year.
        assert_eq!(next_n(&yearly(11, 26, "08:00"), "2026-11-26T07:59:59Z", &utc, 1), ["2026-11-26 08:00 +00"]);
        assert_eq!(next_n(&yearly(11, 26, "08:00"), "2026-11-26T08:00:00Z", &utc, 1), ["2027-11-26 08:00 +00"]);
        // 31 December rolls over the year.
        assert_eq!(next_n(&yearly(12, 31, "23:30"), "2026-12-31T23:30:00Z", &utc, 1), ["2027-12-31 23:30 +00"]);
    }

    #[test]
    fn yearly_keeps_the_wall_clock_across_time_zone_rules() {
        // 15 March 2027 in Denver is MDT; 15 November 2027 is MST.
        let denver = tz("America/Denver");
        assert_eq!(next_n(&yearly(3, 15, "06:30"), "2027-01-01T00:00:00Z", &denver, 1), ["2027-03-15 06:30 -06"]);
        assert_eq!(next_n(&yearly(11, 15, "06:30"), "2027-01-01T00:00:00Z", &denver, 1), ["2027-11-15 06:30 -07"]);
    }

    #[test]
    fn a_monthly_or_yearly_time_in_the_skipped_hour_moves_forward() {
        let denver = tz("America/Denver");
        // 02:30 does not exist on 8 March 2026.
        assert_eq!(next_n(&yearly(3, 8, "02:30"), "2026-01-01T00:00:00Z", &denver, 1), ["2026-03-08 03:30 -06"]);
        assert_eq!(next_n(&monthly(8, "02:30"), "2026-03-01T00:00:00Z", &denver, 1), ["2026-03-08 03:30 -06"]);
    }

    #[test]
    fn monthly_and_yearly_follow_a_time_zone_change() {
        let after = ts("2026-11-25T00:00:00Z");
        assert_eq!(next_after(&monthly(26, "06:30"), after, &tz("America/Denver")).unwrap().unwrap(), ts("2026-11-26T13:30:00Z"));
        assert_eq!(next_after(&monthly(26, "06:30"), after, &tz("Europe/Berlin")).unwrap().unwrap(), ts("2026-11-26T05:30:00Z"));
    }

    #[test]
    fn latest_in_reaches_back_a_month_for_monthly_and_a_year_for_yearly() {
        let utc = tz("UTC");
        // Off since 5 November; on 2 December: the 15 November occurrence is the newest missed one.
        let got = latest_in(&monthly(15, "09:00"), ts("2026-11-05T00:00:00Z"), ts("2026-12-02T10:00:00Z"), &utc).unwrap();
        assert_eq!(got, Some(ts("2026-11-15T09:00:00Z")));
        // Several months passed: only the newest.
        let got = latest_in(&monthly(15, "09:00"), ts("2026-06-01T00:00:00Z"), ts("2026-12-20T10:00:00Z"), &utc).unwrap();
        assert_eq!(got, Some(ts("2026-12-15T09:00:00Z")));
        // A yearly from the previous spring.
        let got = latest_in(&yearly(3, 15, "08:00"), ts("2026-01-01T00:00:00Z"), ts("2026-11-26T00:00:00Z"), &utc).unwrap();
        assert_eq!(got, Some(ts("2026-03-15T08:00:00Z")));
        assert_eq!(latest_in(&yearly(3, 15, "08:00"), ts("2026-03-15T08:00:00Z"), ts("2026-11-26T00:00:00Z"), &utc).unwrap(), None);
    }

    #[test]
    fn bad_monthly_and_yearly_rules_are_errors() {
        let utc = tz("UTC");
        let t = ts("2026-11-25T00:00:00Z");
        assert!(next_after(&monthly(0, "09:00"), t, &utc).is_err());
        assert!(next_after(&monthly(32, "09:00"), t, &utc).is_err());
        assert!(next_after(&monthly(5, "9am"), t, &utc).is_err());
        assert!(next_after(&yearly(13, 1, "09:00"), t, &utc).is_err());
        assert!(next_after(&yearly(0, 1, "09:00"), t, &utc).is_err());
        assert!(next_after(&yearly(3, 0, "09:00"), t, &utc).is_err());
    }

    #[test]
    fn bad_times_are_errors() {
        let utc = tz("UTC");
        assert!(next_after(&daily("25:00"), ts("2026-11-25T00:00:00Z"), &utc).is_err());
        assert!(next_after(&Repeat::Once { date: "2026-13-01".into(), time: "10:00".into() }, ts("2026-11-25T00:00:00Z"), &utc).is_err());
    }
}

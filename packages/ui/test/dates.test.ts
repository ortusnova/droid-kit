import { describe, expect, it } from 'vitest';
import { CalendarDate, Time } from '@internationalized/date';
import {
  cadenceOfKind,
  twoLetters,
  dialAngle,
  dialHour,
  dialMinute,
  from12Hour,
  isoWeekday,
  minuteChoices,
  safeLocale,
  snapMinute,
  to12Hour,
  toggleWeekday,
  uses12HourClock,
  weekOf,
  weekdayOrder,
} from '../src/dates-logic';

describe('week start follows the locale', () => {
  it('en-US weeks start on Sunday', () => {
    expect(weekdayOrder('en-US')).toEqual([7, 1, 2, 3, 4, 5, 6]);
    expect(weekOf(new CalendarDate(2026, 11, 25), 'en-US')[0].toString()).toBe('2026-11-22');
  });
  it('en-GB weeks start on Monday', () => {
    expect(weekdayOrder('en-GB')).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(weekOf(new CalendarDate(2026, 11, 25), 'en-GB')[0].toString()).toBe('2026-11-23');
  });
  it('ISO weekdays', () => {
    expect(isoWeekday(new CalendarDate(2026, 11, 23))).toBe(1);
    expect(isoWeekday(new CalendarDate(2026, 11, 29))).toBe(7);
  });
});

describe('cadence', () => {
  it('weekly on Monday and Thursday', () => {
    let c = cadenceOfKind('weekly', undefined, 1);
    expect(c).toEqual({ kind: 'weekly', weekdays: [1] });
    c = toggleWeekday(c as { kind: 'weekly'; weekdays: (1 | 4)[] }, 4);
    expect(c).toEqual({ kind: 'weekly', weekdays: [1, 4] });
  });
  it('keeps at least one weekday', () => {
    expect(toggleWeekday({ kind: 'weekly', weekdays: [3] }, 3)).toEqual({ kind: 'weekly', weekdays: [3] });
  });
  it('keeps the weekdays when switching away and back', () => {
    const weekly = { kind: 'weekly' as const, weekdays: [2, 5] as (2 | 5)[] };
    expect(cadenceOfKind('daily', weekly)).toEqual({ kind: 'daily' });
    expect(cadenceOfKind('weekly', weekly)).toEqual(weekly);
  });
});

describe('time', () => {
  it('12-hour clock by locale', () => {
    expect(uses12HourClock('en-US')).toBe(true);
    expect(uses12HourClock('en-GB')).toBe(false);
    expect(uses12HourClock('de-DE')).toBe(false);
  });
  it('converts between 12 and 24 hours', () => {
    expect(to12Hour(new Time(6, 45))).toEqual({ hour: 6, minute: 45, pm: false });
    expect(to12Hour(new Time(0, 5))).toEqual({ hour: 12, minute: 5, pm: false });
    expect(to12Hour(new Time(12, 0))).toEqual({ hour: 12, minute: 0, pm: true });
    expect(to12Hour(new Time(18, 30))).toEqual({ hour: 6, minute: 30, pm: true });
    expect(from12Hour(12, 0, false).hour).toBe(0);
    expect(from12Hour(12, 0, true).hour).toBe(12);
    expect(from12Hour(6, 45, true).toString()).toBe('18:45:00');
  });
  it('minute steps', () => {
    expect(minuteChoices(5)).toHaveLength(12);
    expect(minuteChoices(5).at(-1)).toBe(55);
    expect(minuteChoices(1)).toHaveLength(60);
    expect(snapMinute(47, 5)).toBe(45);
    expect(snapMinute(47, 1)).toBe(47);
  });
});

describe('dial dragging', () => {
  const at = (minute: number) => dialAngle(Math.sin((minute / 60) * 2 * Math.PI), -Math.cos((minute / 60) * 2 * Math.PI));
  it('reads every minute around the dial with a 1-minute step', () => {
    for (let m = 0; m < 60; m++) expect(dialMinute(at(m), 1)).toBe(m);
    expect(dialMinute(at(59.6), 1)).toBe(0);
  });
  it('rounds to the 5-minute step', () => {
    expect(dialMinute(at(47), 5)).toBe(45);
    expect(dialMinute(at(48), 5)).toBe(50);
    expect(dialMinute(at(58), 5)).toBe(0);
  });
  it('reads hours on the outer and inner rings', () => {
    expect(dialHour(at(0), false)).toBe(12);
    expect(dialHour(at(30), false)).toBe(6);
    expect(dialHour(at(0), true)).toBe(0);
    expect(dialHour(at(5), true)).toBe(13);
    expect(dialHour(at(55), true)).toBe(23);
  });
});

describe('locales from the environment', () => {
  it('turns POSIX locale names into language tags', () => {
    expect(safeLocale('en_US.utf8')).toBe('en-US');
    expect(safeLocale('de_DE@euro')).toBe('de-DE');
    expect(safeLocale('fr_CA.UTF-8')).toBe('fr-CA');
  });
  it('keeps a valid tag, extensions included', () => {
    expect(safeLocale('en-GB')).toBe('en-GB');
    expect(safeLocale('en-US-u-fw-mon')).toBe('en-US-u-fw-mon');
  });
  it('falls back to en-US for C, POSIX, empty and invalid values', () => {
    for (const bad of ['C', 'c', 'POSIX', 'C.UTF-8', '', '  ', null, undefined, '???', 'x_y_z_!!']) {
      expect(safeLocale(bad as string | null | undefined)).toBe('en-US');
    }
  });
  it('gives the date logic a usable locale whatever it is passed', () => {
    expect(() => weekdayOrder('C')).not.toThrow();
    expect(() => weekOf(new CalendarDate(2026, 11, 25), 'C')).not.toThrow();
    expect(uses12HourClock('C')).toBe(true);
    expect(weekdayOrder('C')[0]).toBe(7);
  });
});

describe('weekday labels', () => {
  it('uses two letters, so Tuesday and Thursday differ', () => {
    const f = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' });
    const week = [1, 2, 3, 4, 5, 6, 7].map(d => twoLetters(f.format(new Date(Date.UTC(2026, 10, 22 + d)))));
    expect(week).toEqual(['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']);
    expect(new Set(week).size).toBe(7);
  });
  it('keeps names that are already short, and drops an abbreviation dot', () => {
    expect(twoLetters('日')).toBe('日');
    expect(twoLetters('lun.')).toBe('lu');
  });
});

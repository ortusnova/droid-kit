import { describe, expect, it } from 'vitest';
import { CalendarDate, Time } from '@internationalized/date';
import {
  LAST_DAY,
  cadenceOfKind,
  dayLabel,
  isCadence,
  maxDayOfMonth,
  monthWeeks,
  setYearlyMonth,
  type Cadence,
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

describe('cadence values', () => {
  it('daily, weekly, times a week, monthly and yearly have exactly the D5 shapes', () => {
    const values: Cadence[] = [
      { kind: 'daily' },
      { kind: 'weekly', weekdays: [1, 4] },
      { kind: 'timesPerWeek', times: 3 },
      { kind: 'monthly', day: 15 },
      { kind: 'monthly', day: LAST_DAY },
      { kind: 'yearly', month: 3, day: 15 },
      { kind: 'yearly', month: 2, day: 29 },
    ];
    for (const v of values) expect(isCadence(JSON.parse(JSON.stringify(v)))).toBe(true);
    expect(LAST_DAY).toBe(31);
  });
  it('rejects values outside the ranges', () => {
    for (const bad of [
      null,
      'daily',
      { kind: 'hourly' },
      { kind: 'weekly', weekdays: [] },
      { kind: 'weekly', weekdays: [0] },
      { kind: 'weekly', weekdays: [8] },
      { kind: 'weekly', weekdays: [1, 1] },
      { kind: 'timesPerWeek', times: 0 },
      { kind: 'timesPerWeek', times: 7 },
      { kind: 'timesPerWeek', times: 2.5 },
      { kind: 'monthly' },
      { kind: 'monthly', day: 0 },
      { kind: 'monthly', day: 32 },
      { kind: 'yearly', month: 13, day: 1 },
      { kind: 'yearly', month: 2, day: 30 },
      { kind: 'yearly', month: 4, day: 31 },
    ])
      expect(isCadence(bad), JSON.stringify(bad)).toBe(false);
  });
  it('allows 29 February but not 30 February', () => {
    expect(maxDayOfMonth(2)).toBe(29);
    expect([1, 3, 4, 12].map(maxDayOfMonth)).toEqual([31, 31, 30, 31]);
  });
  it('a yearly day shrinks to fit when the month changes', () => {
    expect(setYearlyMonth({ kind: 'yearly', month: 3, day: 31 }, 2)).toEqual({ kind: 'yearly', month: 2, day: 29 });
    expect(setYearlyMonth({ kind: 'yearly', month: 3, day: 31 }, 4)).toEqual({ kind: 'yearly', month: 4, day: 30 });
    expect(setYearlyMonth({ kind: 'yearly', month: 3, day: 15 }, 5)).toEqual({ kind: 'yearly', month: 5, day: 15 });
  });
});

describe('switching cadence kinds', () => {
  const anchor = new CalendarDate(2026, 11, 26);
  it('new kinds start from sensible values', () => {
    expect(cadenceOfKind('daily')).toEqual({ kind: 'daily' });
    expect(cadenceOfKind('weekly', { kind: 'daily' }, 4)).toEqual({ kind: 'weekly', weekdays: [4] });
    expect(cadenceOfKind('timesPerWeek', { kind: 'daily' })).toEqual({ kind: 'timesPerWeek', times: 3 });
    expect(cadenceOfKind('monthly', { kind: 'daily' }, 1, { anchor })).toEqual({ kind: 'monthly', day: 26 });
    expect(cadenceOfKind('yearly', { kind: 'daily' }, 1, { anchor })).toEqual({ kind: 'yearly', month: 11, day: 26 });
    expect(cadenceOfKind('monthly')).toEqual({ kind: 'monthly', day: 1 });
    expect(cadenceOfKind('yearly')).toEqual({ kind: 'yearly', month: 1, day: 1 });
  });
  it('keeps the value when the kind does not change', () => {
    const c: Cadence = { kind: 'yearly', month: 3, day: 15 };
    expect(cadenceOfKind('yearly', c, 1, { anchor })).toBe(c);
  });
  it('remembers what was chosen before, for every kind', () => {
    const memory = {
      weekly: { kind: 'weekly' as const, weekdays: [2, 5] as (2 | 5)[] },
      timesPerWeek: { kind: 'timesPerWeek' as const, times: 5 as const },
      monthly: { kind: 'monthly' as const, day: LAST_DAY },
      yearly: { kind: 'yearly' as const, month: 3, day: 15 },
    };
    const from: Cadence = { kind: 'daily' };
    expect(cadenceOfKind('weekly', from, 1, { memory })).toEqual(memory.weekly);
    expect(cadenceOfKind('timesPerWeek', from, 1, { memory })).toEqual(memory.timesPerWeek);
    expect(cadenceOfKind('monthly', from, 1, { memory, anchor })).toEqual(memory.monthly);
    expect(cadenceOfKind('yearly', from, 1, { memory, anchor })).toEqual(memory.yearly);
  });
  it('an empty weekday list is not kept', () => {
    expect(cadenceOfKind('weekly', { kind: 'weekly', weekdays: [] }, 3)).toEqual({ kind: 'weekly', weekdays: [3] });
  });
  it('times a week carries no weekdays and weekly carries no count', () => {
    expect(cadenceOfKind('timesPerWeek', { kind: 'weekly', weekdays: [1, 4] })).toEqual({ kind: 'timesPerWeek', times: 3 });
    expect(cadenceOfKind('weekly', { kind: 'timesPerWeek', times: 3 }, 2)).toEqual({ kind: 'weekly', weekdays: [2] });
  });
});

describe('month grid', () => {
  const nov = new CalendarDate(2026, 11, 26);
  const iso = (weeks: ReturnType<typeof monthWeeks>) => weeks.map(w => w.map(d => d?.day ?? null));
  it('en-US starts on Sunday: 1 November 2026 is a Sunday', () => {
    expect(iso(monthWeeks(nov, 'en-US'))).toEqual([
      [1, 2, 3, 4, 5, 6, 7],
      [8, 9, 10, 11, 12, 13, 14],
      [15, 16, 17, 18, 19, 20, 21],
      [22, 23, 24, 25, 26, 27, 28],
      [29, 30, null, null, null, null, null],
    ]);
  });
  it('en-GB starts on Monday, so the 1st sits in the last column of the first week', () => {
    expect(iso(monthWeeks(nov, 'en-GB'))).toEqual([
      [null, null, null, null, null, null, 1],
      [2, 3, 4, 5, 6, 7, 8],
      [9, 10, 11, 12, 13, 14, 15],
      [16, 17, 18, 19, 20, 21, 22],
      [23, 24, 25, 26, 27, 28, 29],
      [30, null, null, null, null, null, null],
    ]);
  });
  it('a given first day overrides the locale, both ways', () => {
    expect(monthWeeks(nov, 'en-US', 'mon')[0].map(d => d?.day ?? null)).toEqual([null, null, null, null, null, null, 1]);
    expect(monthWeeks(nov, 'en-GB', 'sun')[0].map(d => d?.day ?? null)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(weekdayOrder('en-US', 'mon')).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(weekdayOrder('en-GB', 'sun')).toEqual([7, 1, 2, 3, 4, 5, 6]);
  });
  it('holds every day of the month once, in order, and leaves no empty week', () => {
    for (const [y, m] of [[2026, 2], [2028, 2], [2026, 12], [2027, 5], [2026, 8]]) {
      for (const first of [undefined, 'mon', 'sun'] as const) {
        const weeks = monthWeeks(new CalendarDate(y, m, 10), 'en-US', first);
        const days = weeks.flat().filter(Boolean).map(d => d!.day);
        expect(days).toEqual(Array.from({ length: new CalendarDate(y, m, 1).calendar.getDaysInMonth(new CalendarDate(y, m, 1)) }, (_, i) => i + 1));
        for (const w of weeks) {
          expect(w).toHaveLength(7);
          expect(w.some(Boolean)).toBe(true);
        }
      }
    }
  });
  it('February 2026 starting on Sunday fits four weeks in en-US', () => {
    expect(monthWeeks(new CalendarDate(2026, 2, 1), 'en-US')).toHaveLength(4);
  });
  it('names a day in the locale\'s date format', () => {
    const d = new CalendarDate(2026, 11, 26);
    expect(dayLabel(d, 'en-GB', 'kept')).toBe('26 November: kept');
    expect(dayLabel(d, 'en-US', 'kept')).toBe('November 26: kept');
    expect(dayLabel(d, 'en-GB', 'missed')).toBe('26 November: missed');
    expect(dayLabel(d, 'en-GB', 'short', { short: 'kept, two-minute version' })).toBe('26 November: kept, two-minute version');
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

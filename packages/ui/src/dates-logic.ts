// Pure date and time logic behind the date components, kept apart so it can
// be tested without a DOM.
import { CalendarDate, Time, getDayOfWeek, startOfWeek, today, getLocalTimeZone } from '@internationalized/date';

/** ISO weekday numbers: 1 = Monday … 7 = Sunday. */
export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export type Cadence =
  | { kind: 'daily' }
  | { kind: 'weekly'; weekdays: Weekday[] }
  | { kind: 'monthly' }
  | { kind: 'yearly' };

export type CadenceKind = Cadence['kind'];

/** A cadence of the given kind, keeping the chosen weekdays when it is weekly. */
export function cadenceOfKind(kind: CadenceKind, previous?: Cadence, fallbackWeekday: Weekday = 1): Cadence {
  if (kind === 'weekly') {
    const weekdays = previous?.kind === 'weekly' && previous.weekdays.length ? previous.weekdays : [fallbackWeekday];
    return { kind, weekdays };
  }
  return { kind };
}

/** Toggles a weekday in a weekly cadence; at least one weekday always stays chosen. */
export function toggleWeekday(c: Cadence & { kind: 'weekly' }, day: Weekday): Cadence {
  const has = c.weekdays.includes(day);
  if (has && c.weekdays.length === 1) return c;
  const weekdays = (has ? c.weekdays.filter(d => d !== day) : [...c.weekdays, day]).sort((a, b) => a - b) as Weekday[];
  return { kind: 'weekly', weekdays };
}

/** ISO weekday of a date. */
export function isoWeekday(date: CalendarDate): Weekday {
  // getDayOfWeek with the en-US locale counts from Sunday = 0.
  const fromSunday = getDayOfWeek(date, 'en-US');
  return (fromSunday === 0 ? 7 : fromSunday) as Weekday;
}

/** The seven weekdays in the locale's order, starting on its first day of the week. */
export function weekdayOrder(locale: string): Weekday[] {
  const anchor = new CalendarDate(2026, 11, 25);
  const first = startOfWeek(anchor, locale);
  return Array.from({ length: 7 }, (_, i) => isoWeekday(first.add({ days: i })));
}

/** The seven dates of the week containing `date`, in the locale's order. */
export function weekOf(date: CalendarDate, locale: string): CalendarDate[] {
  const first = startOfWeek(date, locale);
  return Array.from({ length: 7 }, (_, i) => first.add({ days: i }));
}

export function todayLocal(): CalendarDate {
  return today(getLocalTimeZone());
}

/** Whether the locale writes times with a 12-hour clock. */
export function uses12HourClock(locale: string): boolean {
  const cycle = new Intl.DateTimeFormat(locale, { hour: 'numeric' }).resolvedOptions().hourCycle;
  return cycle === 'h12' || cycle === 'h11';
}

/** Rounds minutes down to the step, e.g. 47 with a step of 5 gives 45. */
export function snapMinute(minute: number, step: 1 | 5): number {
  return Math.floor(minute / step) * step;
}

/** The minutes a picker offers for a step. */
export function minuteChoices(step: 1 | 5): number[] {
  return Array.from({ length: 60 / step }, (_, i) => i * step);
}

/** 12-hour display parts of a 24-hour time. */
export function to12Hour(t: Time): { hour: number; minute: number; pm: boolean } {
  const pm = t.hour >= 12;
  const h = t.hour % 12;
  return { hour: h === 0 ? 12 : h, minute: t.minute, pm };
}

/** A 24-hour time from 12-hour parts. */
export function from12Hour(hour: number, minute: number, pm: boolean): Time {
  const h = (hour % 12) + (pm ? 12 : 0);
  return new Time(h, minute);
}

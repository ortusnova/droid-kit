// Pure date and time logic behind the date components, kept apart so it can
// be tested without a DOM.
import { CalendarDate, Time, endOfMonth, getDayOfWeek, startOfMonth, startOfWeek, today, getLocalTimeZone } from '@internationalized/date';

/** ISO weekday numbers: 1 = Monday … 7 = Sunday. */
export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** How many times a week, for a habit that is not tied to weekdays. */
export type TimesPerWeek = 1 | 2 | 3 | 4 | 5 | 6;

/**
 * How often something repeats.
 * - `monthly.day` is 1–31; 31 means the last day, whatever the month's length.
 * - `yearly` allows 29 February (an app decides what it means in other years).
 */
export type Cadence =
  | { kind: 'daily' }
  | { kind: 'weekly'; weekdays: Weekday[] }
  | { kind: 'timesPerWeek'; times: TimesPerWeek }
  | { kind: 'monthly'; day: number }
  | { kind: 'yearly'; month: number; day: number };

export type CadenceKind = Cadence['kind'];

/** The longest each month can be, with February at 29 so 29 February can be chosen. */
const MONTH_MAX_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** The most days a month can have in the yearly picker: 29 for February. Months are 1–12. */
export function maxDayOfMonth(month: number): number {
  return MONTH_MAX_DAYS[month - 1] ?? 31;
}

/** The day of the month that means "the last day". */
export const LAST_DAY = 31;

/** Whether a value, such as one parsed from stored JSON, is a valid cadence. */
export function isCadence(c: unknown): c is Cadence {
  if (typeof c !== 'object' || c === null) return false;
  const v = c as Record<string, unknown>;
  const int = (n: unknown, min: number, max: number) => typeof n === 'number' && Number.isInteger(n) && n >= min && n <= max;
  switch (v.kind) {
    case 'daily':
      return true;
    case 'weekly':
      return Array.isArray(v.weekdays) && v.weekdays.length > 0 && v.weekdays.every(d => int(d, 1, 7)) && new Set(v.weekdays).size === v.weekdays.length;
    case 'timesPerWeek':
      return int(v.times, 1, 6);
    case 'monthly':
      return int(v.day, 1, 31);
    case 'yearly':
      return int(v.month, 1, 12) && int(v.day, 1, maxDayOfMonth(v.month as number));
    default:
      return false;
  }
}

/** Last chosen cadence of each kind, so switching away and back keeps what was picked. */
export type CadenceMemory = Partial<{ [K in CadenceKind]: Extract<Cadence, { kind: K }> }>;

/**
 * A cadence of the given kind. What it holds, in order of preference: the
 * `previous` value when it already is of that kind, the last value of that
 * kind in `memory`, then a default: `fallbackWeekday` for weekly, three times
 * a week, and the day (and month) of `anchor`, or the 1st (of January) without one.
 */
export function cadenceOfKind(
  kind: CadenceKind,
  previous?: Cadence,
  fallbackWeekday: Weekday = 1,
  options: { memory?: CadenceMemory; anchor?: CalendarDate } = {},
): Cadence {
  const usable = (c: Cadence | undefined) => (c?.kind === kind && (c.kind !== 'weekly' || c.weekdays.length > 0) ? c : undefined);
  const kept = usable(previous) ?? usable(options.memory?.[kind]);
  if (kept) return kept;
  const { anchor } = options;
  switch (kind) {
    case 'daily':
      return { kind };
    case 'weekly':
      return { kind, weekdays: [fallbackWeekday] };
    case 'timesPerWeek':
      return { kind, times: 3 };
    case 'monthly':
      return { kind, day: anchor?.day ?? 1 };
    case 'yearly':
      return { kind, month: anchor?.month ?? 1, day: anchor?.day ?? 1 };
  }
}

/** Toggles a weekday in a weekly cadence; at least one weekday always stays chosen. */
export function toggleWeekday(c: Cadence & { kind: 'weekly' }, day: Weekday): Cadence {
  const has = c.weekdays.includes(day);
  if (has && c.weekdays.length === 1) return c;
  const weekdays = (has ? c.weekdays.filter(d => d !== day) : [...c.weekdays, day]).sort((a, b) => a - b) as Weekday[];
  return { kind: 'weekly', weekdays };
}

/** A yearly cadence moved to another month; the day shrinks to fit (31 March → 28/29 February → 29). */
export function setYearlyMonth(c: Cadence & { kind: 'yearly' }, month: number): Cadence {
  return { kind: 'yearly', month, day: Math.min(c.day, maxDayOfMonth(month)) };
}

const FALLBACK_LOCALE = 'en-US';

/**
 * A language tag that `Intl` accepts, made from whatever the environment gave.
 * A POSIX locale name (`en_US.utf8`, `de_DE@euro`) becomes `en-US`, `de-DE`;
 * `C`, `POSIX`, an empty or an invalid value becomes `en-US`. `Intl` throws a
 * RangeError on a tag it cannot parse, and WebKitGTK reports `C` as the
 * language when the process has no locale variables.
 */
export function safeLocale(tag: string | null | undefined): string {
  const name = (tag ?? '').trim().split(/[.@]/)[0]!.replace(/_/g, '-');
  if (!name || /^(c|posix)$/i.test(name)) return FALLBACK_LOCALE;
  try {
    const [supported] = Intl.DateTimeFormat.supportedLocalesOf(new Intl.Locale(name).toString());
    return supported ?? FALLBACK_LOCALE;
  } catch {
    return FALLBACK_LOCALE;
  }
}

/** The system's language as a tag `Intl` accepts: `navigator.language` through `safeLocale`. */
export function systemLocale(): string {
  return safeLocale(typeof navigator === 'undefined' ? undefined : navigator.language);
}

/** ISO weekday of a date. */
export function isoWeekday(date: CalendarDate): Weekday {
  // getDayOfWeek with the en-US locale counts from Sunday = 0.
  const fromSunday = getDayOfWeek(date, 'en-US');
  return (fromSunday === 0 ? 7 : fromSunday) as Weekday;
}

/** A first day of the week an app can choose, overriding the locale's. */
export type FirstDayOfWeek = 'mon' | 'sun';

/** The seven weekdays in the locale's order, or starting on `firstDayOfWeek` when given. */
export function weekdayOrder(locale: string, firstDayOfWeek?: FirstDayOfWeek): Weekday[] {
  const anchor = new CalendarDate(2026, 11, 25);
  const first = startOfWeek(anchor, safeLocale(locale), firstDayOfWeek);
  return Array.from({ length: 7 }, (_, i) => isoWeekday(first.add({ days: i })));
}

/** The seven dates of the week containing `date`, in the locale's order. */
export function weekOf(date: CalendarDate, locale: string): CalendarDate[] {
  const first = startOfWeek(date, safeLocale(locale));
  return Array.from({ length: 7 }, (_, i) => first.add({ days: i }));
}

/**
 * The weeks of the month containing `date`, each of seven entries in the
 * locale's order (or from `firstDayOfWeek`): the dates of the month, and null
 * for the days of the neighbouring months that fill the first and last week.
 */
export function monthWeeks(date: CalendarDate, locale: string, firstDayOfWeek?: FirstDayOfWeek): Array<Array<CalendarDate | null>> {
  const loc = safeLocale(locale);
  const first = startOfMonth(date);
  const last = endOfMonth(date);
  const weeks: Array<Array<CalendarDate | null>> = [];
  for (let start = startOfWeek(first, loc, firstDayOfWeek); start.compare(last) <= 0; start = start.add({ weeks: 1 })) {
    weeks.push(Array.from({ length: 7 }, (_, i) => {
      const d = start.add({ days: i });
      return d.month === first.month && d.year === first.year ? d : null;
    }));
  }
  return weeks;
}

export function todayLocal(): CalendarDate {
  return today(getLocalTimeZone());
}

/** Whether the locale writes times with a 12-hour clock. */
export function uses12HourClock(locale: string): boolean {
  const cycle = new Intl.DateTimeFormat(safeLocale(locale), { hour: 'numeric' }).resolvedOptions().hourCycle;
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

/** Clockwise angle from 12 o'clock, in radians [0, 2π), of a point relative to the dial's centre (y down). */
export function dialAngle(dx: number, dy: number): number {
  const a = Math.atan2(dx, -dy);
  return a < 0 ? a + 2 * Math.PI : a;
}

/** The minute at an angle on the dial, rounded to the minute step. */
export function dialMinute(angle: number, step: 1 | 5): number {
  const m = Math.round((angle / (2 * Math.PI)) * 60);
  return (Math.round(m / step) * step) % 60;
}

/** The hour at an angle: 1–12 on the outer ring; on a 24-hour dial the inner ring is 0 and 13–23. */
export function dialHour(angle: number, innerRing: boolean): number {
  const i = Math.round((angle / (2 * Math.PI)) * 12) % 12;
  if (innerRing) return i === 0 ? 0 : i + 12;
  return i === 0 ? 12 : i;
}

/** The first two letters of a short weekday name ("Thu" → "Th"); names already shorter stay whole. */
export function twoLetters(name: string): string {
  return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(name.replace(/\.$/, ''))].slice(0, 2).map(g => g.segment).join('');
}

/** What an app can record for a day in `MonthMarks`. A day with no mark is `notDue`. */
export type DayMark = 'kept' | 'short' | 'skipped' | 'missed' | 'notDue' | 'upcoming';

/** The words after the date in a day's accessible name ("26 November: kept"). */
export const MARK_LABELS: Record<DayMark, string> = {
  kept: 'kept',
  short: 'kept in short form',
  skipped: 'skipped',
  missed: 'missed',
  notDue: 'not due',
  upcoming: 'upcoming',
};

/** A day's accessible name in the locale's date format: "26 November: kept" for en-GB, "November 26: kept" for en-US. */
export function dayLabel(date: CalendarDate, locale: string, mark: DayMark, labels: Partial<Record<DayMark, string>> = {}): string {
  // Dates are turned into instants at UTC midnight, so format them in UTC too.
  const text = new Intl.DateTimeFormat(safeLocale(locale), { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(date.toDate('UTC'));
  return `${text}: ${labels[mark] ?? MARK_LABELS[mark]}`;
}

// A read-only month: each day shows the mark the app gives it. The marks differ
// in shape as well as colour, so they do not depend on telling colours apart.
import { useState } from 'react';
import { useLocale } from 'react-aria-components';
import { CalendarDate, startOfMonth } from '@internationalized/date';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { IconButton } from './frame';
import { dataAttributes, type DataAttributes } from './dom';
import { dayLabel, monthWeeks, safeLocale, todayLocal, twoLetters, weekdayOrder, type DayMark, type FirstDayOfWeek } from './dates-logic';

const MARK_ICON: Record<DayMark, React.ReactNode> = {
  // A filled check.
  kept: (
    <svg viewBox="0 0 20 20" className="text-success size-5" aria-hidden="true">
      <circle cx="10" cy="10" r="9" fill="currentColor" />
      <path className="text-success-content" d="M5.8 10.4 8.7 13.2 14.2 7.2" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  // A ring with a check.
  short: (
    <svg viewBox="0 0 20 20" className="text-success size-5" aria-hidden="true">
      <circle cx="10" cy="10" r="8.25" fill="none" stroke="currentColor" strokeWidth="1.75" />
      <path d="M6.2 10.3 8.8 12.8 13.8 7.4" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  // A dash.
  skipped: (
    <svg viewBox="0 0 20 20" className="text-muted size-5" aria-hidden="true">
      <path d="M5.5 10h9" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  ),
  // A cross.
  missed: (
    <svg viewBox="0 0 20 20" className="text-error size-5" aria-hidden="true">
      <path d="M6 6l8 8M14 6l-8 8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  ),
  // Nothing.
  notDue: null,
  // A faint dot.
  upcoming: (
    <svg viewBox="0 0 20 20" className="text-muted size-5 opacity-50" aria-hidden="true">
      <circle cx="10" cy="10" r="2.5" fill="currentColor" />
    </svg>
  ),
};

/**
 * One month, read-only, in the locale's week layout (or from `firstDayOfWeek`),
 * with previous and next month buttons.
 * - `marks`: a mark for each day, by ISO date (`'2026-11-26'`); a day without one is `notDue`.
 * - `month` (controlled) or `defaultMonth`: any date in the month shown; today's month by default.
 * - `onMonthChange`: called with the first day of the month the buttons moved to.
 * - `markLabels`: replaces the words in a day's accessible name, e.g. `{ short: 'kept, two-minute version' }`.
 */
export function MonthMarks({
  label = 'Month',
  marks,
  month,
  defaultMonth,
  onMonthChange,
  firstDayOfWeek,
  markLabels,
  ...rest
}: {
  label?: string;
  marks: Record<string, DayMark>;
  month?: CalendarDate;
  defaultMonth?: CalendarDate;
  onMonthChange?: (firstOfMonth: CalendarDate) => void;
  firstDayOfWeek?: FirstDayOfWeek;
  markLabels?: Partial<Record<DayMark, string>>;
} & DataAttributes) {
  const locale = safeLocale(useLocale().locale);
  const [inner, setInner] = useState(() => startOfMonth(defaultMonth ?? todayLocal()));
  const shown = startOfMonth(month ?? inner);
  const go = (delta: number) => {
    const next = shown.add({ months: delta });
    setInner(next);
    onMonthChange?.(next);
  };
  const now = todayLocal();
  // Dates are turned into instants at UTC midnight, so format them in UTC too.
  const title = new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(shown.toDate('UTC'));
  const short = new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' });
  const long = new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' });
  // 2026-11-23 is a Monday: ISO weekday n is that date plus n - 1 days.
  const dateOf = (d: number) => new CalendarDate(2026, 11, 22 + d).toDate('UTC');
  const weeks = monthWeeks(shown, locale, firstDayOfWeek);

  return (
    <div {...dataAttributes(rest)} role="group" aria-label={label} data-first-day={weekdayOrder(locale, firstDayOfWeek)[0]}>
      <header className="mb-1 flex items-center justify-between">
        <IconButton label="Previous month" onPress={() => go(-1)}>
          <ChevronLeft size={20} />
        </IconButton>
        <h3 className="text-body font-semibold" aria-live="polite">{title}</h3>
        <IconButton label="Next month" onPress={() => go(1)}>
          <ChevronRight size={20} />
        </IconButton>
      </header>
      <table className="w-full table-fixed border-collapse">
        <thead>
          <tr>
            {weekdayOrder(locale, firstDayOfWeek).map(d => (
              <th key={d} scope="col" className="text-caption text-muted pb-1 font-normal">
                <span aria-hidden="true">{twoLetters(short.format(dateOf(d)))}</span>
                <span className="sr-only">{long.format(dateOf(d))}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map(week => (
            <tr key={(week.find(Boolean) ?? shown).toString()}>
              {week.map((d, i) => {
                if (!d) return <td key={i} />;
                const mark = marks[d.toString()] ?? 'notDue';
                const isToday = d.compare(now) === 0;
                return (
                  <td key={i} className="p-0">
                    <div
                      role="img"
                      aria-label={dayLabel(d, locale, mark, markLabels)}
                      aria-current={isToday ? 'date' : undefined}
                      data-date={d.toString()}
                      data-mark={mark}
                      className="mx-auto flex h-14 flex-col items-center justify-center gap-0.5"
                    >
                      <span className={`text-caption min-w-6 rounded-full border text-center leading-5 tabular-nums ${isToday ? 'border-primary text-accent-text font-bold' : 'border-transparent'}`}>{d.day}</span>
                      <span className="grid size-5 place-items-center">{MARK_ICON[mark]}</span>
                    </div>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export type { DayMark, FirstDayOfWeek };

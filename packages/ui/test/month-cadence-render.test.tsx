import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { I18nProvider } from 'react-aria-components';
import { CalendarDate } from '@internationalized/date';
import { CadencePicker, MonthMarks, type Cadence, type DayMark } from '../src';

const html = (el: ReactElement, locale = 'en-GB') => renderToStaticMarkup(<I18nProvider locale={locale}>{el}</I18nProvider>);
const picker = (value: Cadence) => html(<CadencePicker value={value} onChange={() => {}} />);
const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;

describe('MonthMarks', () => {
  const marks: Record<string, DayMark> = {
    '2026-11-02': 'kept',
    '2026-11-03': 'short',
    '2026-11-04': 'skipped',
    '2026-11-05': 'missed',
    '2026-11-27': 'upcoming',
  };
  const month = <MonthMarks marks={marks} defaultMonth={new CalendarDate(2026, 11, 15)} />;

  it('gives every day an accessible name with the mark', () => {
    const out = html(month);
    expect(out).toContain('aria-label="2 November: kept"');
    expect(out).toContain('aria-label="3 November: kept in short form"');
    expect(out).toContain('aria-label="4 November: skipped"');
    expect(out).toContain('aria-label="5 November: missed"');
    expect(out).toContain('aria-label="27 November: upcoming"');
    expect(out).toContain('aria-label="26 November: not due"');
    expect(count(out, /role="img"/g)).toBe(30);
  });
  it('uses the locale\'s date format', () => {
    expect(html(month, 'en-US')).toContain('aria-label="November 2: kept"');
  });
  it('shows the month, with previous and next buttons', () => {
    const out = html(month);
    expect(out).toContain('November 2026');
    expect(out).toContain('aria-label="Previous month"');
    expect(out).toContain('aria-label="Next month"');
  });
  it('starts on Monday in en-GB, on Sunday in en-US, and as told', () => {
    const heads = (s: string) => [...s.matchAll(/aria-hidden="true">([A-Za-z]{2})<\/span>/g)].map(m => m[1]);
    expect(heads(html(month, 'en-GB'))).toEqual(['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']);
    expect(heads(html(month, 'en-US'))).toEqual(['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']);
    const monFirst = <MonthMarks marks={marks} defaultMonth={new CalendarDate(2026, 11, 15)} firstDayOfWeek="mon" />;
    const sunFirst = <MonthMarks marks={marks} defaultMonth={new CalendarDate(2026, 11, 15)} firstDayOfWeek="sun" />;
    expect(heads(html(monFirst, 'en-US'))[0]).toBe('Mo');
    expect(heads(html(sunFirst, 'en-GB'))[0]).toBe('Su');
  });
  it('draws each mark with its own shape', () => {
    const shape = (date: string) => html(month).split(`data-date="${date}"`)[1].split('</div>')[0];
    const kept = shape('2026-11-02');
    const short = shape('2026-11-03');
    expect(kept).toContain('<circle cx="10" cy="10" r="9" fill="currentColor"');
    expect(short).toContain('fill="none" stroke="currentColor" stroke-width="1.75"');
    expect(short).not.toContain('r="9"');
    expect(shape('2026-11-04')).toContain('M5.5 10h9');
    expect(shape('2026-11-05')).toContain('M6 6l8 8M14 6l-8 8');
    expect(shape('2026-11-27')).toContain('r="2.5"');
    expect(shape('2026-11-26')).not.toContain('<svg');
  });
});

describe('CadencePicker', () => {
  it('weekly shows the switch and the weekdays', () => {
    const out = picker({ kind: 'weekly', weekdays: [1, 4] });
    expect(out).toContain('On days');
    expect(out).toContain('Times a week');
    expect(out).toContain('aria-label="Weekdays"');
    expect(count(out, /aria-label="(Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day"/g)).toBe(7);
  });
  it('times a week shows 1 to 6 and no weekdays', () => {
    const out = picker({ kind: 'timesPerWeek', times: 3 });
    expect(out).not.toContain('aria-label="Weekdays"');
    for (const n of ['1 time a week', '2 times a week', '3 times a week', '4 times a week', '5 times a week', '6 times a week']) expect(out).toContain(`aria-label="${n}"`);
    expect(out).not.toContain('7 times a week');
  });
  it('monthly shows 1 to 30 and Last day', () => {
    const out = picker({ kind: 'monthly', day: 31 });
    const group = out.split('aria-label="Day of the month"')[1];
    expect(count(group, /<button/g)).toBe(31);
    expect(group).toContain('Last day');
    expect(group).not.toContain('>31<');
  });
  it('yearly shows twelve months and the days of the chosen one', () => {
    const march = picker({ kind: 'yearly', month: 3, day: 15 });
    const [months, days] = march.split('aria-label="Day of March"');
    expect(count(months.split('aria-label="Month"')[1], /<button/g)).toBe(12);
    expect(count(days, /<button/g)).toBe(31);
    const feb = picker({ kind: 'yearly', month: 2, day: 29 });
    expect(count(feb.split('aria-label="Day of February"')[1], /<button/g)).toBe(29);
    expect(count(picker({ kind: 'yearly', month: 4, day: 30 }).split('aria-label="Day of April"')[1], /<button/g)).toBe(30);
  });
  it('daily has nothing more to pick', () => {
    const out = picker({ kind: 'daily' });
    expect(out).not.toContain('Weekdays');
    expect(out).not.toContain('Day of');
  });
});

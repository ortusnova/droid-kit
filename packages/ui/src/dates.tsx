// Date and time components. React Aria provides the calendar, date picker and
// the typed time field; the touch time picker panels are the kit's own,
// because React Aria has none and WebKitGTK shows no native picker.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import {
  Button as AriaButton,
  Calendar,
  CalendarCell,
  CalendarGrid,
  CalendarGridBody,
  CalendarGridHeader,
  CalendarHeaderCell,
  CalendarMonthPicker,
  CalendarYearPicker,
  DateInput,
  DatePicker as AriaDatePicker,
  DateSegment,
  Dialog,
  Group,
  Heading,
  Label,
  Popover,
  TimeField,
  ToggleButton,
  ToggleButtonGroup,
  useLocale,
} from 'react-aria-components';
import { CalendarDate, Time } from '@internationalized/date';
import { CalendarDays, ChevronLeft, ChevronRight, Clock, Keyboard } from 'lucide-react';
import { Button, SegmentedControl } from './controls';
import { IconButton } from './frame';
import { Sheet } from './overlays';
import { useCloseOnBack } from './back';
import { dataAttributes, type DataAttributes } from './dom';
import {
  LAST_DAY,
  cadenceOfKind,
  maxDayOfMonth,
  setYearlyMonth,
  twoLetters,
  safeLocale,
  dialAngle,
  dialHour,
  dialMinute,
  from12Hour,
  isoWeekday,
  minuteChoices,
  snapMinute,
  to12Hour,
  toggleWeekday,
  todayLocal,
  uses12HourClock,
  weekOf,
  weekdayOrder,
  type Cadence,
  type CadenceKind,
  type CadenceMemory,
  type TimesPerWeek,
  type Weekday,
} from './dates-logic';

export type TimePanel = 'wheel' | 'dial';

const pad = (n: number) => String(n).padStart(2, '0');

// ---------------------------------------------------------------- time picker

/**
 * A time field with a touch picker. Tapping the field with a finger opens the
 * picker panel, so no keyboard appears; with a keyboard or mouse the hours and
 * minutes can be typed. The panel's keyboard button switches to typing.
 */
export function TimePicker({
  label,
  value,
  defaultValue,
  onChange,
  minuteStep = 1,
  panel = 'dial',
  hourCycle,
  ...rest
}: {
  label: string;
  value?: Time;
  defaultValue?: Time;
  onChange?: (t: Time) => void;
  minuteStep?: 1 | 5;
  panel?: TimePanel;
  hourCycle?: 12 | 24;
} & DataAttributes) {
  const locale = safeLocale(useLocale().locale);
  const twelve = hourCycle ? hourCycle === 12 : uses12HourClock(locale);
  const [inner, setInner] = useState<Time>(defaultValue ?? new Time(9, 0));
  const time = value ?? inner;
  const set = (t: Time) => {
    setInner(t);
    onChange?.(t);
  };
  const [open, setOpen] = useState(false);
  const fieldRef = useRef<HTMLDivElement>(null);

  const typeInstead = () => {
    setOpen(false);
    setTimeout(() => fieldRef.current?.querySelector<HTMLElement>('[role="spinbutton"]')?.focus(), 400);
  };

  return (
    <div {...dataAttributes(rest)} className="fieldset">
      <TimeField
        value={time}
        onChange={t => t && set(t)}
        hourCycle={twelve ? 12 : 24}
        className="flex flex-col gap-1"
      >
        <Label className="fieldset-legend text-small">{label}</Label>
        <div className="flex items-center gap-1" ref={fieldRef}>
          <DateInput
            className="input border-control bg-base-200 text-body min-h-touch flex-1 gap-0"
            onPointerDownCapture={e => {
              if (e.pointerType === 'touch') {
                e.preventDefault();
                e.stopPropagation();
                setOpen(true);
              }
            }}
          >
            {segment => <DateSegment segment={segment} className="dk-segment" />}
          </DateInput>
          <IconButton label={`Pick ${label.toLowerCase()}`} onPress={() => setOpen(true)}>
            <Clock size={20} />
          </IconButton>
        </div>
      </TimeField>
      <TimePanelSheet
        isOpen={open}
        title={label}
        initial={time}
        twelve={twelve}
        minuteStep={minuteStep}
        panel={panel}
        onCancel={() => setOpen(false)}
        onSet={t => {
          set(t);
          setOpen(false);
        }}
        onType={typeInstead}
      />
    </div>
  );
}

function TimePanelSheet({
  isOpen,
  title,
  initial,
  twelve,
  minuteStep,
  panel,
  onCancel,
  onSet,
  onType,
}: {
  isOpen: boolean;
  title: string;
  initial: Time;
  twelve: boolean;
  minuteStep: 1 | 5;
  panel: TimePanel;
  onCancel: () => void;
  onSet: (t: Time) => void;
  onType: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  useEffect(() => {
    if (isOpen) setDraft(new Time(initial.hour, snapMinute(initial.minute, minuteStep)));
  }, [isOpen, initial, minuteStep]);
  const Panel = panel === 'wheel' ? WheelPanel : DialPanel;
  return (
    <Sheet isOpen={isOpen} onClose={onCancel} title={title} closeOnBack>
      <p className="text-headline mb-3 text-center font-bold tabular-nums" aria-live="polite" data-testid="time-preview">
        {formatTime(draft, twelve)}
      </p>
      <Panel value={draft} onChange={setDraft} twelve={twelve} minuteStep={minuteStep} />
      <div className="mt-4 flex items-center gap-2">
        <IconButton label="Type the time instead" onPress={onType}>
          <Keyboard size={20} />
        </IconButton>
        <span className="flex-1" />
        <Button variant="ghost" onPress={onCancel}>Cancel</Button>
        <Button variant="primary" onPress={() => onSet(draft)} id="time-set">Set</Button>
      </div>
    </Sheet>
  );
}

function formatTime(t: Time, twelve: boolean): string {
  if (!twelve) return `${pad(t.hour)}:${pad(t.minute)}`;
  const p = to12Hour(t);
  return `${p.hour}:${pad(p.minute)} ${p.pm ? 'PM' : 'AM'}`;
}

interface PanelProps {
  value: Time;
  onChange: (t: Time) => void;
  twelve: boolean;
  minuteStep: 1 | 5;
}

function hourChoices(twelve: boolean) {
  return twelve ? Array.from({ length: 12 }, (_, i) => i + 1) : Array.from({ length: 24 }, (_, i) => i);
}

/** Splits a time into what the panels show, and puts it back together. */
function useParts({ value, onChange, twelve }: PanelProps) {
  const p12 = to12Hour(value);
  return {
    hour: twelve ? p12.hour : value.hour,
    minute: value.minute,
    pm: p12.pm,
    setHour: (h: number) => onChange(twelve ? from12Hour(h, value.minute, p12.pm) : new Time(h, value.minute)),
    setMinute: (m: number) => onChange(new Time(value.hour, m)),
    setPm: (pm: boolean) => onChange(from12Hour(p12.hour, value.minute, pm)),
  };
}

function AmPm({ pm, onChange }: { pm: boolean; onChange: (pm: boolean) => void }) {
  return (
    <SegmentedControl
      label="AM or PM"
      options={[
        { id: 'am', label: 'AM' },
        { id: 'pm', label: 'PM' },
      ]}
      value={pm ? 'pm' : 'am'}
      onChange={v => onChange(v === 'pm')}
    />
  );
}

// Wheel: scroll-snap columns, like iOS and many Android apps.
const ITEM = 44;
const VISIBLE = 5;

function Wheel({ label, items, value, onChange }: { label: string; items: Array<{ value: number; label: string }>; value: number; onChange: (v: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const index = Math.max(0, items.findIndex(i => i.value === value));
  const settling = useRef<number | undefined>(undefined);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el && Math.round(el.scrollTop / ITEM) !== index) el.scrollTop = index * ITEM;
  }, [index]);

  const onScroll = () => {
    window.clearTimeout(settling.current);
    settling.current = window.setTimeout(() => {
      const el = ref.current;
      if (!el) return;
      const i = Math.min(items.length - 1, Math.max(0, Math.round(el.scrollTop / ITEM)));
      if (items[i].value !== value) onChange(items[i].value);
    }, 120);
  };

  return (
    <div className="relative flex-1">
      <div aria-hidden className="bg-base-200 rounded-field pointer-events-none absolute inset-x-0" style={{ top: ITEM * 2, height: ITEM }} />
      <div
        ref={ref}
        role="listbox"
        aria-label={label}
        onScroll={onScroll}
        className="relative snap-y snap-mandatory overflow-y-auto"
        style={{ height: ITEM * VISIBLE, paddingBlock: ITEM * 2, scrollbarWidth: 'none' }}
      >
        {items.map(item => (
          <button
            key={item.value}
            role="option"
            aria-selected={item.value === value}
            className={`text-title block w-full snap-center text-center tabular-nums ${item.value === value ? 'font-bold' : 'text-muted'}`}
            style={{ height: ITEM }}
            onClick={() => onChange(item.value)}
          >
            {item.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function WheelPanel(props: PanelProps) {
  const parts = useParts(props);
  const minutes = minuteChoices(props.minuteStep);
  return (
    <div className="flex items-stretch gap-2" data-panel="wheel">
      <Wheel label="Hour" items={hourChoices(props.twelve).map(h => ({ value: h, label: props.twelve ? String(h) : pad(h) }))} value={parts.hour} onChange={parts.setHour} />
      <Wheel label="Minute" items={minutes.map(m => ({ value: m, label: pad(m) }))} value={parts.minute} onChange={parts.setMinute} />
      {props.twelve && (
        <Wheel
          label="AM or PM"
          items={[
            { value: 0, label: 'AM' },
            { value: 1, label: 'PM' },
          ]}
          value={parts.pm ? 1 : 0}
          onChange={v => parts.setPm(v === 1)}
        />
      )}
    </div>
  );
}

// Dial: a clock face with an Hour/Minute switch. Tap or drag around the face to pick.
function DialPanel(props: PanelProps) {
  const parts = useParts(props);
  const [step, setStep] = useState<'hour' | 'minute'>('hour');
  const size = 264;
  const radius = 104;
  const outer = step === 'hour' ? hourChoices(true) : minuteChoices(5);
  const inner = step === 'hour' && !props.twelve ? [0, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23] : [];
  const selected = step === 'hour' ? parts.hour : parts.minute;

  const place = (i: number, r: number) => {
    const a = (i / 12) * 2 * Math.PI;
    return { left: size / 2 + r * Math.sin(a), top: size / 2 - r * Math.cos(a), translate: '-50% -50%' };
  };
  // Hands: the hour hand is shorter than the minute hand. Both always show; the one not being picked is dimmed.
  const centre = size / 2;
  const tip = (at: number, length: number) => ({
    x: centre + length * Math.sin((at / 12) * 2 * Math.PI),
    y: centre - length * Math.cos((at / 12) * 2 * Math.PI),
  });
  const hourOnInner = !props.twelve && (parts.hour === 0 || parts.hour > 12);
  const hourHand = tip(parts.hour % 12, radius - 52);
  // The minute hand stops at the edge of the selection dot (radius 22), short of the numbers.
  const minuteHand = tip(parts.minute / 5, radius - 22);
  const hourMark = tip(parts.hour % 12, hourOnInner ? radius - 48 : radius);
  // The selection dot sits beyond the hand's tip, so it follows a drag minute by minute.
  const dot = step === 'hour' ? hourMark : tip(parts.minute / 5, radius);
  // Picking a value stays on its step; the Hour/Minute control switches (Brian's choice).
  const pick = (v: number) => (step === 'hour' ? parts.setHour(v) : parts.setMinute(v));

  // Dragging around the face picks any value; on minutes it follows the minute step.
  const face = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const fromPointer = (e: ReactPointerEvent) => {
    const r = face.current!.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2);
    const dy = e.clientY - (r.top + r.height / 2);
    const angle = dialAngle(dx, dy);
    if (step === 'hour') parts.setHour(dialHour(angle, !props.twelve && Math.hypot(dx, dy) < radius - 24));
    else parts.setMinute(dialMinute(angle, props.minuteStep));
  };
  const onPointerDown = (e: ReactPointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    dragging.current = true;
    face.current!.setPointerCapture(e.pointerId);
    fromPointer(e);
    e.preventDefault();
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    if (dragging.current) fromPointer(e);
  };
  const onPointerUp = (e: ReactPointerEvent) => {
    if (!dragging.current) return;
    dragging.current = false;
    fromPointer(e);
  };
  const mark = (v: number, i: number, r: number) => (
    <button
      key={`${r}-${v}`}
      aria-pressed={v === selected}
      aria-label={step === 'hour' ? `${v} o'clock` : `${v} minutes`}
      className={`size-touch absolute grid place-items-center rounded-full font-semibold tabular-nums outline-offset-2 focus-visible:outline-2 ${v === selected ? 'text-primary-content' : ''}`}
      style={place(i, r)}
      // Pointer input is handled by the face; a click here from a tap would land after
      // the step changed and set the minute to the hour. Only keyboard clicks (detail 0) count.
      onClick={e => e.detail === 0 && pick(v)}
    >
      {step === 'minute' ? pad(v) : v}
    </button>
  );

  return (
    <div className="flex flex-col items-center gap-3 *:w-full" data-panel="dial">
      <SegmentedControl
        label="Hour or minute"
        options={[
          { id: 'hour', label: 'Hour' },
          { id: 'minute', label: 'Minute' },
        ]}
        value={step}
        onChange={setStep}
      />
      <div
        ref={face}
        className="bg-base-200 relative touch-none rounded-full select-none"
        style={{ width: size, height: size, flex: 'none', maxWidth: size }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => (dragging.current = false)}
      >
        <svg className="text-primary pointer-events-none absolute inset-0" width={size} height={size} aria-hidden="true">
          {/* 60 ticks just inside the rim, clear of the numbers (which end about 12 px past their ring); hours and 5-minute marks are longer. */}
          <g className="text-muted" stroke="currentColor" strokeLinecap="round">
            {Array.from({ length: 60 }, (_, m) => {
              const a = (m / 60) * 2 * Math.PI;
              const outerR = centre - 3;
              const innerR = outerR - (m % 5 === 0 ? 9 : 4);
              return (
                <line
                  key={m}
                  x1={centre + innerR * Math.sin(a)}
                  y1={centre - innerR * Math.cos(a)}
                  x2={centre + outerR * Math.sin(a)}
                  y2={centre - outerR * Math.cos(a)}
                  strokeWidth={m % 5 === 0 ? 1.5 : 1}
                  opacity={m % 5 === 0 ? 0.8 : 0.5}
                />
              );
            })}
          </g>
          <line x1={centre} y1={centre} x2={hourHand.x} y2={hourHand.y} stroke="currentColor" strokeWidth={4} strokeLinecap="round" opacity={step === 'minute' ? 0.35 : 1} />
          <line x1={centre} y1={centre} x2={minuteHand.x} y2={minuteHand.y} stroke="currentColor" strokeWidth={2} strokeLinecap="round" opacity={step === 'hour' ? 0.35 : 1} />
          <circle cx={dot.x} cy={dot.y} r={22} fill="currentColor" />
          {step === 'minute' && parts.minute % 5 !== 0 && <circle className="text-primary-content" cx={dot.x} cy={dot.y} r={3} fill="currentColor" />}
          <circle cx={centre} cy={centre} r={5} fill="currentColor" />
        </svg>
        {outer.map((v, i) => mark(v, step === 'hour' ? (v % 12) : i, radius))}
        {inner.map((v, i) => mark(v, i, radius - 48))}
      </div>
      {props.twelve && <AmPm pm={parts.pm} onChange={parts.setPm} />}
    </div>
  );
}

// ---------------------------------------------------------------- calendar and date picker

/** A month calendar. Weeks start on the locale's first day. */
export function MonthCalendar({
  label = 'Month',
  value,
  defaultValue,
  onChange,
  ...rest
}: { label?: string; value?: CalendarDate; defaultValue?: CalendarDate; onChange?: (d: CalendarDate) => void } & DataAttributes) {
  return (
    <Calendar {...dataAttributes(rest)} aria-label={label} value={value} defaultValue={defaultValue} onChange={d => onChange?.(d as CalendarDate)}>
      <CalendarBody />
    </Calendar>
  );
}

/**
 * The calendar's inside. The month and the year in the header are buttons that
 * switch to a grid of months or of years, for jumping far without paging.
 */
function CalendarBody() {
  const now = todayLocal();
  const [view, setView] = useState<'days' | 'months' | 'years'>('days');
  const headerButton = (active: boolean) => `btn btn-ghost min-h-touch h-auto px-2 text-body font-semibold ${active ? 'text-accent-text' : ''}`;
  const choice = (selected: boolean) => `btn min-h-touch h-auto px-0 font-normal ${selected ? 'btn-primary' : 'btn-ghost'}`;
  return (
    <>
      <header className="mb-1 flex items-center justify-between">
        <AriaButton slot="previous" aria-label="Previous month" className={`btn btn-ghost btn-circle size-touch ${view === 'days' ? '' : 'invisible'}`}>
          <ChevronLeft size={20} />
        </AriaButton>
        <Heading className="sr-only" />
        <div className="flex items-center">
          <CalendarMonthPicker format="long">
            {({ items, value }) => (
              <button type="button" className={headerButton(view === 'months')} aria-expanded={view === 'months'} onClick={() => setView(view === 'months' ? 'days' : 'months')}>
                {items.find(i => i.id === value)?.formatted}
              </button>
            )}
          </CalendarMonthPicker>
          <CalendarYearPicker>
            {({ items, value }) => (
              <button type="button" className={headerButton(view === 'years')} aria-expanded={view === 'years'} onClick={() => setView(view === 'years' ? 'days' : 'years')}>
                {items.find(i => i.id === value)?.formatted}
              </button>
            )}
          </CalendarYearPicker>
        </div>
        <AriaButton slot="next" aria-label="Next month" className={`btn btn-ghost btn-circle size-touch ${view === 'days' ? '' : 'invisible'}`}>
          <ChevronRight size={20} />
        </AriaButton>
      </header>
      {view === 'months' && (
        <CalendarMonthPicker format="short">
          {({ items, value, onChange, 'aria-label': label }) => (
            <div role="group" aria-label={label} className="grid grid-cols-3 gap-1" data-calendar-view="months">
              {items.map(i => (
                <button key={i.id} type="button" aria-pressed={i.id === value} className={choice(i.id === value)} onClick={() => (onChange(i.id), setView('days'))}>
                  {i.formatted}
                </button>
              ))}
            </div>
          )}
        </CalendarMonthPicker>
      )}
      {view === 'years' && (
        <CalendarYearPicker visibleYears={41}>
          {({ items, value, onChange, 'aria-label': label }) => <YearGrid label={label} items={items} value={value} onPick={id => (onChange(id), setView('days'))} choice={choice} />}
        </CalendarYearPicker>
      )}
      {view === 'days' && (
        <CalendarGrid weekdayStyle="narrow" className="w-full border-separate border-spacing-y-0.5 [&_td]:p-0 [&_th]:p-0">
          <CalendarGridHeader>{day => <CalendarHeaderCell className="text-caption text-muted pb-1 font-normal">{day}</CalendarHeaderCell>}</CalendarGridHeader>
          <CalendarGridBody>
            {date => (
              <CalendarCell
                date={date}
                className={({ isSelected, isOutsideMonth, isFocusVisible }) =>
                  [
                    'btn btn-circle size-touch mx-auto min-h-0 font-normal',
                    isSelected ? 'btn-primary' : 'btn-ghost',
                    !isSelected && date.compare(now) === 0 ? 'border-primary text-accent-text' : '',
                    isOutsideMonth ? 'invisible' : '',
                    isFocusVisible ? 'outline-primary outline-2 outline-offset-2' : '',
                  ].join(' ')
                }
              />
            )}
          </CalendarGridBody>
        </CalendarGrid>
      )}
    </>
  );
}

/** Years around the shown one, scrolled so the shown year is in the middle. */
function YearGrid({ label, items, value, onPick, choice }: { label: string; items: { id: number; formatted: string }[]; value: unknown; onPick: (id: number) => void; choice: (selected: boolean) => string }) {
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    // Not scrollIntoView: inside a sheet that would scroll the sheet itself.
    const el = box.current?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (box.current && el) box.current.scrollTop = el.offsetTop - box.current.clientHeight / 2 + el.offsetHeight / 2;
  }, []);
  return (
    <div ref={box} role="group" aria-label={label} className="relative grid max-h-72 grid-cols-4 gap-1 overflow-y-auto" data-calendar-view="years">
      {items.map(i => (
        <button key={i.id} type="button" aria-pressed={i.id === value} className={choice(i.id === value)} onClick={() => onPick(i.id)}>
          {i.formatted}
        </button>
      ))}
    </div>
  );
}

/** A date field with a calendar that opens below it. */
export function DatePicker({
  label,
  value,
  defaultValue,
  onChange,
  ...rest
}: { label: string; value?: CalendarDate; defaultValue?: CalendarDate; onChange?: (d: CalendarDate) => void } & DataAttributes) {
  const [open, setOpen] = useState(false);
  useCloseOnBack(open, () => setOpen(false));
  return (
    <AriaDatePicker {...dataAttributes(rest)} className="fieldset" isOpen={open} onOpenChange={setOpen} value={value} defaultValue={defaultValue} onChange={d => d && onChange?.(d as CalendarDate)}>
      <Label className="fieldset-legend text-small">{label}</Label>
      <Group className="flex items-center gap-1">
        <DateInput className="input border-control bg-base-200 text-body min-h-touch flex-1 gap-0">{segment => <DateSegment segment={segment} className="dk-segment" />}</DateInput>
        <AriaButton aria-label={`Choose ${label.toLowerCase()}`} className="btn btn-ghost btn-circle size-touch">
          <CalendarDays size={20} />
        </AriaButton>
      </Group>
      <Popover className="bg-raised rounded-box border-divider border p-2 shadow-lg" placement="bottom end">
        <Dialog className="outline-none">
          <Calendar>
            <CalendarBody />
          </Calendar>
        </Dialog>
      </Popover>
    </AriaDatePicker>
  );
}

// ---------------------------------------------------------------- week strip

/** The seven days of a week, in the locale's order, with today marked. */
export function WeekStrip({ value, onChange, ...rest }: { value: CalendarDate; onChange: (d: CalendarDate) => void } & DataAttributes) {
  const locale = safeLocale(useLocale().locale);
  const days = useMemo(() => weekOf(value, locale), [value, locale]);
  const now = todayLocal();
  // Dates are turned into instants at UTC midnight, so format them in UTC too.
  const weekday = new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' });
  return (
    <ToggleButtonGroup
      {...dataAttributes(rest)}
      aria-label="Day"
      selectionMode="single"
      disallowEmptySelection
      selectedKeys={[value.toString()]}
      onSelectionChange={keys => {
        const [k] = [...keys];
        const d = days.find(x => x.toString() === k);
        if (d) onChange(d);
      }}
      className="grid grid-cols-7"
    >
      {days.map(d => {
        const isToday = d.compare(now) === 0;
        return (
          <ToggleButton
            key={d.toString()}
            id={d.toString()}
            aria-current={isToday ? 'date' : undefined}
            className={({ isSelected }) =>
              `btn h-14 min-h-touch flex-col gap-0 px-0 ${isSelected ? 'btn-primary' : 'btn-ghost'} ${isToday && !isSelected ? 'border-primary' : ''}`
            }
          >
            <span className="text-caption font-normal">{weekday.format(d.toDate('UTC'))}</span>
            <span className="text-body">{d.day}</span>
          </ToggleButton>
        );
      })}
    </ToggleButtonGroup>
  );
}

// ---------------------------------------------------------------- cadence

const KINDS: Array<{ id: 'daily' | 'weekly' | 'monthly' | 'yearly'; label: string }> = [
  { id: 'daily', label: 'Daily' },
  { id: 'weekly', label: 'Weekly' },
  { id: 'monthly', label: 'Monthly' },
  { id: 'yearly', label: 'Yearly' },
];

const WEEKLY_MODES: Array<{ id: 'weekly' | 'timesPerWeek'; label: string }> = [
  { id: 'weekly', label: 'On days' },
  { id: 'timesPerWeek', label: 'Times a week' },
];

const TIMES: TimesPerWeek[] = [1, 2, 3, 4, 5, 6];

// Static class names, so Tailwind finds them.
const COLUMNS = { 4: 'grid-cols-4', 6: 'grid-cols-6', 7: 'grid-cols-7' } as const;

interface Choice {
  id: number;
  text: string;
  /** Accessible name, when the visible text is not enough. */
  name?: string;
  /** Columns the button spans. */
  span?: 3;
}

/**
 * One value out of a grid of touch-sized buttons: the week strip's cells, 44 px
 * each, seven to a row. `round` makes circles (days, counts); otherwise
 * rectangles that fill their column (months, "Last day").
 */
function ChoiceGrid({ label, columns, choices, value, onChange, round }: { label: string; columns: 4 | 6 | 7; choices: Choice[]; value: number; onChange: (id: number) => void; round?: boolean }) {
  return (
    <ToggleButtonGroup
      aria-label={label}
      selectionMode="single"
      disallowEmptySelection
      selectedKeys={[String(value)]}
      onSelectionChange={keys => {
        const [k] = [...keys];
        if (k !== undefined) onChange(Number(k));
      }}
      className={`grid ${COLUMNS[columns]} ${columns === 4 ? 'gap-1' : ''}`}
    >
      {choices.map(c => (
        <ToggleButton
          key={c.id}
          id={String(c.id)}
          aria-label={c.name}
          className={({ isSelected }) =>
            `btn min-h-0 font-normal ${round && !c.span ? 'btn-circle size-touch mx-auto' : 'h-touch px-0'} ${c.span ? 'col-span-3' : ''} ${isSelected ? 'btn-primary' : 'btn-ghost bg-base-200'}`
          }
        >
          {c.text}
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  );
}

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

/**
 * How often something repeats: daily; weekly, on chosen weekdays or a number
 * of times a week; monthly, on a day of the month or the last day; yearly, on
 * a month and day. Everything is chosen by tapping, with no keyboard.
 */
export function CadencePicker({ label = 'Cadence', value, onChange, ...rest }: { label?: string; value: Cadence; onChange: (c: Cadence) => void } & DataAttributes) {
  const locale = safeLocale(useLocale().locale);
  const order = weekdayOrder(locale);
  // Dates are turned into instants at UTC midnight, so format them in UTC too.
  // Two letters (Mo Tu We Th Fr Sa Su), so no two buttons look alike as one-letter names do (Brian, 2026-11-26).
  const short = new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' });
  const long = new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' });
  const monthShort = new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' });
  const monthLong = new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' });
  // 2026-11-23 is a Monday: ISO weekday n is that date plus n - 1 days.
  const dateOf = (d: Weekday) => new CalendarDate(2026, 11, 22 + d).toDate('UTC');
  const monthDate = (m: number) => new CalendarDate(2026, m, 1).toDate('UTC');

  // What was chosen before, so a switch to another kind and back keeps it.
  const memory = useRef<CadenceMemory>({});
  const lastWeekly = useRef<'weekly' | 'timesPerWeek'>('weekly');
  (memory.current as Record<string, Cadence>)[value.kind] = value;
  if (value.kind === 'weekly' || value.kind === 'timesPerWeek') lastWeekly.current = value.kind;
  const switchTo = (kind: CadenceKind) => onChange(cadenceOfKind(kind, value, isoWeekday(todayLocal()), { memory: memory.current, anchor: todayLocal() }));

  const isWeekly = value.kind === 'weekly' || value.kind === 'timesPerWeek';
  return (
    <div {...dataAttributes(rest)} className="fieldset gap-2">
      <span className="fieldset-legend text-small" id="cadence-label">{label}</span>
      <SegmentedControl
        label={label}
        options={KINDS}
        value={isWeekly ? 'weekly' : value.kind}
        onChange={k => (k === 'weekly' ? (isWeekly ? undefined : switchTo(lastWeekly.current)) : switchTo(k))}
      />
      {isWeekly && <SegmentedControl label="Weekly repeat" options={WEEKLY_MODES} value={value.kind as 'weekly' | 'timesPerWeek'} onChange={switchTo} />}
      {value.kind === 'weekly' && (
        <ToggleButtonGroup
          aria-label="Weekdays"
          selectionMode="multiple"
          selectedKeys={value.weekdays.map(String)}
          className="flex justify-between"
        >
          {order.map(d => (
            <ToggleButton
              key={d}
              id={String(d)}
              aria-label={long.format(dateOf(d))}
              onPress={() => onChange(toggleWeekday(value, d))}
              className={({ isSelected }) => `btn btn-circle size-touch min-h-0 ${isSelected ? 'btn-primary' : 'btn-ghost bg-base-200'}`}
            >
              {twoLetters(short.format(dateOf(d)))}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
      )}
      {value.kind === 'timesPerWeek' && (
        <ChoiceGrid
          label="Times a week"
          columns={6}
          round
          value={value.times}
          choices={TIMES.map(n => ({ id: n, text: String(n), name: n === 1 ? '1 time a week' : `${n} times a week` }))}
          onChange={n => onChange({ kind: 'timesPerWeek', times: n as TimesPerWeek })}
        />
      )}
      {value.kind === 'monthly' && (
        <ChoiceGrid
          label="Day of the month"
          columns={7}
          round
          value={value.day}
          choices={[...range(1, 30).map(n => ({ id: n, text: String(n) })), { id: LAST_DAY, text: 'Last day', span: 3 as const }]}
          onChange={day => onChange({ kind: 'monthly', day })}
        />
      )}
      {value.kind === 'yearly' && (
        <>
          <ChoiceGrid
            label="Month"
            columns={4}
            value={value.month}
            choices={range(1, 12).map(m => ({ id: m, text: monthShort.format(monthDate(m)), name: monthLong.format(monthDate(m)) }))}
            onChange={m => onChange(setYearlyMonth(value, m))}
          />
          <ChoiceGrid
            label={`Day of ${monthLong.format(monthDate(value.month))}`}
            columns={7}
            round
            value={value.day}
            choices={range(1, maxDayOfMonth(value.month)).map(n => ({ id: n, text: String(n) }))}
            onChange={day => onChange({ kind: 'yearly', month: value.month, day })}
          />
        </>
      )}
    </div>
  );
}

export type { Cadence, CadenceKind, TimesPerWeek, Weekday };
export { Time, CalendarDate };

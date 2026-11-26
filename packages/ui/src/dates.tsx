// Date and time components. React Aria provides the calendar, date picker and
// the typed time field; the touch time picker panels are the kit's own,
// because React Aria has none and WebKitGTK shows no native picker.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Button as AriaButton,
  Calendar,
  CalendarCell,
  CalendarGrid,
  CalendarGridBody,
  CalendarGridHeader,
  CalendarHeaderCell,
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
import {
  cadenceOfKind,
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
  type Weekday,
} from './dates-logic';

export type TimePanel = 'wheel' | 'dial' | 'chips';

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
  minuteStep = 5,
  panel = 'wheel',
  hourCycle,
}: {
  label: string;
  value?: Time;
  defaultValue?: Time;
  onChange?: (t: Time) => void;
  minuteStep?: 1 | 5;
  panel?: TimePanel;
  hourCycle?: 12 | 24;
}) {
  const { locale } = useLocale();
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
    <div className="fieldset">
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
  const Panel = panel === 'wheel' ? WheelPanel : panel === 'dial' ? DialPanel : ChipsPanel;
  return (
    <Sheet isOpen={isOpen} onClose={onCancel} title={title}>
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

// Dial: a clock face, hour first and then minutes, like Android's clock dialog.
function DialPanel(props: PanelProps) {
  const parts = useParts(props);
  const [step, setStep] = useState<'hour' | 'minute'>('hour');
  const size = 264;
  const radius = 104;
  const outer = step === 'hour' ? hourChoices(true) : minuteChoices(5);
  const inner = step === 'hour' && !props.twelve ? [0, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23] : [];
  const selected = step === 'hour' ? parts.hour : props.minuteStep === 5 ? parts.minute : snapMinute(parts.minute, 5);

  const place = (i: number, r: number) => {
    const a = (i / 12) * 2 * Math.PI;
    return { left: size / 2 + r * Math.sin(a) - 22, top: size / 2 - r * Math.cos(a) - 22 };
  };
  const pick = (v: number) => {
    if (step === 'hour') {
      parts.setHour(props.twelve ? v : v);
      setStep('minute');
    } else parts.setMinute(v);
  };
  const mark = (v: number, i: number, r: number) => (
    <button
      key={`${r}-${v}`}
      aria-pressed={v === selected}
      aria-label={step === 'hour' ? `${v} o'clock` : `${v} minutes`}
      className={`btn btn-circle absolute size-11 min-h-0 border-0 tabular-nums shadow-none ${v === selected ? 'btn-primary' : 'btn-ghost'}`}
      style={place(i, r)}
      onClick={() => pick(v)}
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
      <div className="bg-base-200 relative rounded-full" style={{ width: size, height: size, flex: 'none', maxWidth: size }}>
        {outer.map((v, i) => mark(v, step === 'hour' ? (v % 12) : i, radius))}
        {inner.map((v, i) => mark(v, i, radius - 48))}
      </div>
      {step === 'minute' && props.minuteStep === 1 && (
        <div className="flex items-center gap-2">
          <Button onPress={() => parts.setMinute((parts.minute + 59) % 60)}>−1 min</Button>
          <Button onPress={() => parts.setMinute((parts.minute + 1) % 60)}>+1 min</Button>
        </div>
      )}
      {props.twelve && <AmPm pm={parts.pm} onChange={parts.setPm} />}
    </div>
  );
}

// Chips: every hour, then every minute, as a grid of buttons.
function ChipsPanel(props: PanelProps) {
  const parts = useParts(props);
  const chip = (active: boolean) => `btn min-h-touch h-11 px-0 tabular-nums ${active ? 'btn-primary' : 'btn-ghost bg-base-200'}`;
  return (
    <div className="flex flex-col gap-3" data-panel="chips">
      <div>
        <p className="text-small text-muted mb-1">Hour</p>
        <div className="grid grid-cols-6 gap-1" role="group" aria-label="Hour">
          {hourChoices(props.twelve).map(h => (
            <button key={h} aria-pressed={h === parts.hour} className={chip(h === parts.hour)} onClick={() => parts.setHour(h)}>
              {props.twelve ? h : pad(h)}
            </button>
          ))}
        </div>
      </div>
      <div>
        <p className="text-small text-muted mb-1">Minute</p>
        <div className="grid grid-cols-6 gap-1" role="group" aria-label="Minute">
          {minuteChoices(props.minuteStep).map(m => (
            <button key={m} aria-pressed={m === parts.minute} className={chip(m === parts.minute)} onClick={() => parts.setMinute(m)}>
              {pad(m)}
            </button>
          ))}
        </div>
      </div>
      {props.twelve && <AmPm pm={parts.pm} onChange={parts.setPm} />}
    </div>
  );
}

// ---------------------------------------------------------------- calendar and date picker

/** A month calendar. Weeks start on the locale's first day. */
export function MonthCalendar({ label = 'Month', value, defaultValue, onChange }: { label?: string; value?: CalendarDate; defaultValue?: CalendarDate; onChange?: (d: CalendarDate) => void }) {
  return (
    <Calendar aria-label={label} value={value} defaultValue={defaultValue} onChange={d => onChange?.(d as CalendarDate)} className="p-1">
      <CalendarBody />
    </Calendar>
  );
}

function CalendarBody() {
  const now = todayLocal();
  return (
    <>
      <header className="mb-1 flex items-center justify-between">
        <AriaButton slot="previous" aria-label="Previous month" className="btn btn-ghost btn-circle size-touch">
          <ChevronLeft size={20} />
        </AriaButton>
        <Heading className="text-body font-semibold" />
        <AriaButton slot="next" aria-label="Next month" className="btn btn-ghost btn-circle size-touch">
          <ChevronRight size={20} />
        </AriaButton>
      </header>
      <CalendarGrid weekdayStyle="narrow" className="w-full border-separate border-spacing-y-0.5">
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
    </>
  );
}

/** A date field with a calendar that opens below it. */
export function DatePicker({ label, value, defaultValue, onChange }: { label: string; value?: CalendarDate; defaultValue?: CalendarDate; onChange?: (d: CalendarDate) => void }) {
  return (
    <AriaDatePicker className="fieldset" value={value} defaultValue={defaultValue} onChange={d => d && onChange?.(d as CalendarDate)}>
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
export function WeekStrip({ value, onChange }: { value: CalendarDate; onChange: (d: CalendarDate) => void }) {
  const { locale } = useLocale();
  const days = useMemo(() => weekOf(value, locale), [value, locale]);
  const now = todayLocal();
  // Dates are turned into instants at UTC midnight, so format them in UTC too.
  const weekday = new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' });
  return (
    <ToggleButtonGroup
      aria-label="Day"
      selectionMode="single"
      disallowEmptySelection
      selectedKeys={[value.toString()]}
      onSelectionChange={keys => {
        const [k] = [...keys];
        const d = days.find(x => x.toString() === k);
        if (d) onChange(d);
      }}
      className="grid grid-cols-7 gap-1"
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

const KINDS: Array<{ id: CadenceKind; label: string }> = [
  { id: 'daily', label: 'Daily' },
  { id: 'weekly', label: 'Weekly' },
  { id: 'monthly', label: 'Monthly' },
  { id: 'yearly', label: 'Yearly' },
];

/** How often something repeats; for weekly, on which weekdays. */
export function CadencePicker({ label = 'Cadence', value, onChange }: { label?: string; value: Cadence; onChange: (c: Cadence) => void }) {
  const { locale } = useLocale();
  const order = weekdayOrder(locale);
  // Dates are turned into instants at UTC midnight, so format them in UTC too.
  const narrow = new Intl.DateTimeFormat(locale, { weekday: 'narrow', timeZone: 'UTC' });
  const long = new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' });
  // 2026-11-23 is a Monday: ISO weekday n is that date plus n - 1 days.
  const dateOf = (d: Weekday) => new CalendarDate(2026, 11, 22 + d).toDate('UTC');
  return (
    <div className="fieldset gap-2">
      <span className="fieldset-legend text-small" id="cadence-label">{label}</span>
      <SegmentedControl label={label} options={KINDS} value={value.kind} onChange={k => onChange(cadenceOfKind(k, value, isoWeekday(todayLocal())))} />
      {value.kind === 'weekly' && (
        <ToggleButtonGroup
          aria-label="Weekdays"
          selectionMode="multiple"
          selectedKeys={value.weekdays.map(String)}
          className="flex justify-between gap-1"
        >
          {order.map(d => (
            <ToggleButton
              key={d}
              id={String(d)}
              aria-label={long.format(dateOf(d))}
              onPress={() => onChange(toggleWeekday(value, d))}
              className={({ isSelected }) => `btn btn-circle size-touch min-h-0 ${isSelected ? 'btn-primary' : 'btn-ghost bg-base-200'}`}
            >
              {narrow.format(dateOf(d))}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
      )}
    </div>
  );
}

export type { Cadence, CadenceKind, Weekday };
export { Time, CalendarDate };

// Every kit component, with its documentation and a demo of each state.
// Each component's page renders the demo twice, under data-theme="light" and
// data-theme="dark".
import { useState, type ReactNode } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { Bell, CalendarDays, Flame, Inbox, NotebookPen, Plus, Settings2, Sun, Target } from 'lucide-react';
import {
  AppBar,
  Badge,
  Button,
  CadencePicker,
  CalendarDate,
  Callout,
  Card,
  CheckboxRow,
  ConfirmDialog,
  DatePicker,
  EmptyState,
  Fab,
  IconButton,
  List,
  ListRow,
  MonthCalendar,
  MonthMarks,
  ProgressBar,
  ProgressRing,
  SegmentedControl,
  Select,
  Sheet,
  SwitchRow,
  TabBar,
  TextArea,
  TextField,
  Time,
  TimePicker,
  WeekStrip,
  showToast,
  type Cadence,
  type DayMark,
  type TimePanel,
} from '@droid-kit/ui';

export interface Entry {
  name: string;
  title: string;
  group: 'Frame' | 'Overlays' | 'Content' | 'Controls' | 'Dates and times';
  /** Props and states, one line each. */
  docs: string[];
  /** The states, rendered once per theme. */
  demo: () => ReactNode;
  /** Shown once, outside the themed demos (overlays and live counters). */
  live?: () => ReactNode;
}

const PRIORITIES = [
  { id: 'health', label: 'Health' },
  { id: 'craft', label: 'Craft' },
  { id: 'people', label: 'Relationships' },
];

function Labelled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-caption text-muted">{label}</span>
      {children}
    </div>
  );
}

function FabDemo() {
  const [presses, setPresses] = useState(0);
  return (
    <div className="flex items-center gap-4">
      <Fab label="New habit" onPress={() => setPresses(p => p + 1)}>
        <Plus size={24} />
      </Fab>
      <span id="fab-presses">Pressed {presses} times</span>
    </div>
  );
}

function SheetDemo() {
  const { sheet } = useSearch({ strict: false }) as { sheet?: string };
  const navigate = useNavigate();
  const close = () => history.back();
  return (
    <>
      <div className="flex items-center gap-4">
        <Button id="open-sheet" variant="primary" onPress={() => navigate({ to: '.', search: { sheet: 'demo' } })}>
          Open the sheet
        </Button>
        <Fab label="New habit" onPress={() => navigate({ to: '.', search: { sheet: 'demo' } })}>
          <Plus size={24} />
        </Fab>
      </div>
      <Sheet isOpen={sheet === 'demo'} onClose={close} title="New habit">
        <div className="flex flex-col gap-1">
          <TextField label="Habit" placeholder="Meditate for two minutes" />
          <TextField label="Cue" defaultValue="After I pour my coffee" />
          <Select label="Priority" options={PRIORITIES} defaultValue="health" />
          <TimePicker label="Time" defaultValue={new Time(8, 0)} />
          <DatePicker label="Start date" defaultValue={new CalendarDate(2026, 11, 25)} />
          <TextArea label="Notes" placeholder="Why this matters" />
          {Array.from({ length: 4 }, (_, i) => (
            <TextField key={i} label={`Extra field ${i + 1}`} placeholder="Makes the sheet taller than the screen" />
          ))}
          <TextField label="Last field" placeholder="Near the bottom: the keyboard must not hide it" />
          <div className="mt-3 flex justify-end gap-2">
            <Button variant="ghost" onPress={close}>Cancel</Button>
            <Button variant="primary" onPress={close}>Save habit</Button>
          </div>
        </div>
      </Sheet>
    </>
  );
}

function ConfirmDemo() {
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState('none');
  return (
    <>
      <Button id="open-confirm" variant="danger" onPress={() => setOpen(true)}>Delete habit…</Button>
      <span className="text-small ml-3" id="confirm-result">Result: {result}</span>
      <ConfirmDialog
        isOpen={open}
        title="Delete “Morning run”?"
        body="Its 12-day streak and history will be removed."
        confirmLabel="Delete"
        destructive
        onCancel={() => {
          setOpen(false);
          setResult('cancelled');
        }}
        onConfirm={() => {
          setOpen(false);
          setResult('deleted');
        }}
      />
    </>
  );
}

function TimeDemo({ panel, step = 1, cycle }: { panel: TimePanel; step?: 1 | 5; cycle?: 12 | 24 }) {
  const [t, setT] = useState(new Time(6, 45));
  return (
    <div data-time-demo={`${panel}-${step}-${cycle ?? 'locale'}`}>
      <TimePicker label="Time" value={t} onChange={setT} panel={panel} minuteStep={step} hourCycle={cycle} />
      <span className="text-caption text-muted" data-value>{t.toString()}</span>
    </div>
  );
}

function CadenceDemo({ initial, label }: { initial: Cadence; label: string }) {
  const [c, setC] = useState<Cadence>(initial);
  return (
    <div className="flex flex-col gap-1" data-cadence-demo={label}>
      <CadencePicker label={label} value={c} onChange={setC} />
      <span className="text-caption text-muted" data-cadence>{JSON.stringify(c)}</span>
    </div>
  );
}

// November 2026 as a habit tracker might show it, as of the 26th.
const NOVEMBER_MARKS: Record<string, DayMark> = {
  '2026-11-02': 'kept',
  '2026-11-03': 'kept',
  '2026-11-04': 'short',
  '2026-11-05': 'kept',
  '2026-11-06': 'missed',
  '2026-11-09': 'kept',
  '2026-11-10': 'skipped',
  '2026-11-11': 'kept',
  '2026-11-12': 'short',
  '2026-11-13': 'kept',
  '2026-11-16': 'missed',
  '2026-11-17': 'kept',
  '2026-11-18': 'kept',
  '2026-11-19': 'short',
  '2026-11-20': 'kept',
  '2026-11-23': 'kept',
  '2026-11-24': 'skipped',
  '2026-11-25': 'kept',
  '2026-11-26': 'kept',
  '2026-11-27': 'upcoming',
  '2026-11-30': 'upcoming',
};

function MarksDemo({ firstDayOfWeek }: { firstDayOfWeek?: 'mon' | 'sun' }) {
  const [month, setMonth] = useState(new CalendarDate(2026, 11, 1));
  return (
    <div className="flex flex-col gap-2" data-marks-demo={firstDayOfWeek ?? 'locale'}>
      <MonthMarks label="Morning run" month={month} onMonthChange={setMonth} marks={NOVEMBER_MARKS} firstDayOfWeek={firstDayOfWeek} markLabels={{ short: 'kept, two-minute version' }} />
      <ul className="text-caption text-muted flex flex-wrap gap-x-3 gap-y-1" aria-label="Marks">
        <li>Filled check: kept</li>
        <li>Ring with check: two-minute version</li>
        <li>Dash: skipped</li>
        <li>Cross: missed</li>
        <li>Dot: upcoming</li>
      </ul>
    </div>
  );
}

function WeekDemo() {
  const [d, setD] = useState(new CalendarDate(2026, 11, 25));
  return <WeekStrip value={d} onChange={setD} />;
}

export const ENTRIES: Entry[] = [
  {
    name: 'app-bar',
    title: 'App bar',
    group: 'Frame',
    docs: ['title, subtitle?', 'onBack? — shows a back button; required below a tab root (Linux has no system back)', 'actions? — icon buttons on the right', 'Pads itself by --dk-inset-top/left/right'],
    demo: () => (
      <div className="flex flex-col gap-2 overflow-hidden">
        <AppBar title="Today" subtitle="Wednesday, November 25" actions={<IconButton label="Settings"><Settings2 size={20} /></IconButton>} />
        <AppBar title="Morning run" onBack={() => {}} />
      </div>
    ),
  },
  {
    name: 'tab-bar',
    title: 'Tab bar',
    group: 'Frame',
    docs: ['tabs: { id, label, href, icon }[]', 'active: the current tab id', 'Tabs are links: the app wraps itself in React Aria’s RouterProvider', 'Pads itself by --dk-inset-bottom so its buttons stay above the gesture area'],
    demo: () => (
      <TabBar
        active="today"
        tabs={[
          { id: 'today', label: 'Today', href: '#', icon: <Sun size={20} /> },
          { id: 'week', label: 'Week', href: '#', icon: <CalendarDays size={20} /> },
          { id: 'priorities', label: 'Priorities', href: '#', icon: <Target size={20} /> },
          { id: 'review', label: 'Review', href: '#', icon: <NotebookPen size={20} /> },
        ]}
      />
    ),
  },
  {
    name: 'fab',
    title: 'Floating action button',
    group: 'Frame',
    docs: ['label — accessible name', 'onPress', 'Not daisyUI’s .fab: that class drops pointer events on focus, so a finger tap never fires', 'AppShell places it above the tab bar'],
    demo: () => <FabDemo />,
  },
  {
    name: 'icon-button',
    title: 'Icon button',
    group: 'Controls',
    docs: ['label — accessible name (required)', 'onPress, isDisabled', '44 px hit area'],
    demo: () => (
      <div className="flex gap-2">
        <IconButton label="Notifications"><Bell size={20} /></IconButton>
        <IconButton label="Settings (disabled)" isDisabled><Settings2 size={20} /></IconButton>
      </div>
    ),
  },
  {
    name: 'sheet',
    title: 'Bottom sheet',
    group: 'Overlays',
    docs: ['isOpen, onClose, title', 'Closes by swipe down, backdrop tap, Escape — and by back when its open state is in the history (here ?sheet=demo)', 'closeOnBack — for a sheet that is not in the history: the back action calls onClose, topmost overlay only (the time picker’s panel does this)', 'Scrolls when taller than the screen; keeps a focused field above the keyboard', 'Covers the app bar, tab bar and floating button'],
    demo: () => <p className="text-muted">The sheet opens over the whole screen; use the button below.</p>,
    live: () => <SheetDemo />,
  },
  {
    name: 'confirm-dialog',
    title: 'Confirm dialog',
    group: 'Overlays',
    docs: ['isOpen, title, body?, confirmLabel, cancelLabel?', 'onConfirm, onCancel', 'destructive — red confirm button', 'Escape, a tap outside and the Android back action cancel (closeOnBack={false} when the app keeps the dialog in the history)'],
    demo: () => <p className="text-muted">The dialog opens over the whole screen; use the button below.</p>,
    live: () => <ConfirmDemo />,
  },
  {
    name: 'toast',
    title: 'Toast',
    group: 'Overlays',
    docs: ['showToast(message, { action?, seconds? })', 'ToastRegion — render once near the root', 'Announced politely to screen readers'],
    demo: () => <p className="text-muted">Toasts appear above the tab bar.</p>,
    live: () => (
      <div className="flex gap-2">
        <Button onPress={() => showToast('Habit saved')}>Show a toast</Button>
        <Button onPress={() => showToast('Habit deleted', { action: { label: 'Undo', onPress: () => showToast('Restored') } })}>With an action</Button>
      </div>
    ),
  },
  {
    name: 'card',
    title: 'Card',
    group: 'Content',
    docs: ['title?, subtitle?, children, actions?'],
    demo: () => (
      <Card title="Weekly review" subtitle="14 of 19 done so far." actions={<><Button variant="ghost">Later</Button><Button variant="primary">Start review</Button></>}>
        <p>Take five minutes on Sunday to look back.</p>
      </Card>
    ),
  },
  {
    name: 'list',
    title: 'List and list row',
    group: 'Content',
    docs: ['List: title?, subtitle?, children', 'ListRow: title, subtitle?, leading?, trailing?, href? (a link with a chevron)'],
    demo: () => (
      <List title="Health" subtitle="I take care of my body">
        <ListRow title="Morning run" subtitle="After coffee · 6:30" trailing={<Badge tone="accent" icon={<Flame size={12} />}>12</Badge>} />
        <ListRow title="Open a habit" subtitle="A row that links to a screen" href="#" />
      </List>
    ),
  },
  {
    name: 'empty-state',
    title: 'Empty state',
    group: 'Content',
    docs: ['icon?, title, body?, action?'],
    demo: () => <EmptyState icon={<Inbox size={40} />} title="No priorities yet" body="Priorities are the parts of your life your habits serve." action={<Button variant="primary">Add a priority</Button>} />,
  },
  {
    name: 'badge',
    title: 'Badge',
    group: 'Content',
    docs: ['tone: neutral | accent | success | warning | danger', 'icon?'],
    demo: () => (
      <div className="flex flex-wrap gap-2">
        <Badge>5</Badge>
        <Badge tone="accent" icon={<Flame size={12} />}>12 days</Badge>
        <Badge tone="success">Done</Badge>
        <Badge tone="warning">Restart</Badge>
        <Badge tone="danger">Missed</Badge>
      </div>
    ),
  },
  {
    name: 'progress',
    title: 'Progress bar and ring',
    group: 'Content',
    docs: ['ProgressBar: label, value, max?', 'ProgressRing: label, value (0–100), children (the centre text)'],
    demo: () => (
      <div className="flex items-center gap-4">
        <ProgressRing label="Habits done today" value={57}>4/7</ProgressRing>
        <div className="flex-1"><ProgressBar label="Habits done today" value={4} max={7} /></div>
      </div>
    ),
  },
  {
    name: 'callout',
    title: 'Callout',
    group: 'Content',
    docs: ['tone: accent | success | warning | danger', 'title?, children?', 'urgent — role=alert instead of role=status'],
    demo: () => (
      <div className="flex flex-col gap-2">
        <Callout tone="warning" title="Never miss twice">You skipped “Read 10 pages” yesterday. Do the two-minute version today.</Callout>
        <Callout tone="success" title="12 days in a row" />
        <Callout tone="accent">Reminders are off for this habit.</Callout>
        <Callout tone="danger" title="Could not save">Try again.</Callout>
      </div>
    ),
  },
  {
    name: 'button',
    title: 'Button',
    group: 'Controls',
    docs: ['variant: primary | secondary | ghost | danger | neutral', 'block?, isDisabled?, onPress'],
    demo: () => (
      <div className="flex flex-wrap gap-2">
        <Button variant="primary">Save habit</Button>
        <Button variant="secondary">Skip today</Button>
        <Button>Later</Button>
        <Button variant="ghost">Cancel</Button>
        <Button variant="danger">Delete</Button>
        <Button variant="primary" isDisabled>Disabled</Button>
      </div>
    ),
  },
  {
    name: 'text-field',
    title: 'Text field and text area',
    group: 'Controls',
    docs: ['label, placeholder?, value/defaultValue, onChange', 'description?, isRequired?, isInvalid + errorMessage'],
    demo: () => (
      <div className="flex flex-col gap-1">
        <TextField label="Habit" placeholder="Meditate for two minutes" />
        <TextField label="Cue" defaultValue="After I pour my coffee" description="When, where, or after which habit" />
        <TextField label="Two-minute version" isInvalid errorMessage="Keep it to something that takes two minutes" defaultValue="Run 10 km" />
        <TextArea label="Notes" placeholder="Why this matters" />
      </div>
    ),
  },
  {
    name: 'select',
    title: 'Select',
    group: 'Controls',
    docs: ['label, options: { id, label }[]', 'value/defaultValue, onChange', 'The list opens in a popover; each option is 44 px tall', 'The Android back action closes the open list only'],
    demo: () => (
      <div className="grid grid-cols-2 gap-3">
        <Select label="Priority" options={PRIORITIES} defaultValue="health" />
        <Select label="Empty" options={PRIORITIES} />
      </div>
    ),
  },
  {
    name: 'checkbox-row',
    title: 'Checkbox row',
    group: 'Controls',
    docs: ['title, subtitle?, trailing?', 'isSelected/defaultSelected, onChange', 'data-* attributes (test hooks) reach the row’s element — every kit component passes them to its root', 'The whole row is the hit area'],
    demo: () => (
      <List>
        <li><CheckboxRow title="Morning run" subtitle="After coffee · 6:30" defaultSelected trailing={<Badge tone="accent">12</Badge>} /></li>
        <li><CheckboxRow title="Lights out by 10:30" subtitle="Evening · bedroom" trailing={<Badge>5</Badge>} /></li>
      </List>
    ),
  },
  {
    name: 'switch-row',
    title: 'Switch row',
    group: 'Controls',
    docs: ['title, subtitle?', 'isSelected/defaultSelected, onChange', 'The whole row is the hit area'],
    demo: () => (
      <div>
        <SwitchRow title="Remind me" subtitle="A nudge at the cue time" defaultSelected />
        <SwitchRow title="Count weekends" />
      </div>
    ),
  },
  {
    name: 'segmented',
    title: 'Segmented control',
    group: 'Controls',
    docs: ['label, options: { id, label }[]', 'value/defaultValue, onChange', 'The selected segment is lighter than its track in both themes'],
    demo: () => (
      <SegmentedControl label="Range" defaultValue="day" options={[{ id: 'day', label: 'Day' }, { id: 'week', label: 'Week' }, { id: 'month', label: 'Month' }, { id: 'year', label: 'Year' }]} />
    ),
  },
  {
    name: 'time-picker',
    title: 'Time picker',
    group: 'Dates and times',
    docs: [
      'label, value/defaultValue (Time), onChange',
      'minuteStep: 1 (default) | 5; hourCycle?: 12 | 24 (default: the locale)',
      'panel: dial (default) | wheel — Brian chose these two on 2026-11-25',
      'The panel is a sheet outside the history: the Android back action closes only the panel, not the sheet under it',
      'A finger tap on the field opens the panel, with no keyboard; a keyboard or mouse can type; the panel’s keyboard button switches to typing',
    ],
    demo: () => <p className="text-muted">The picker opens in a sheet; try both styles below.</p>,
    live: () => (
      <div className="flex flex-col gap-4">
        <Labelled label="Dial (default): tap or drag around the face"><TimeDemo panel="dial" /></Labelled>
        <Labelled label="Dial, 5-minute steps"><TimeDemo panel="dial" step={5} /></Labelled>
        <Labelled label="Wheel"><TimeDemo panel="wheel" /></Labelled>
        <Labelled label="Wheel, 24-hour, 5-minute steps"><TimeDemo panel="wheel" step={5} cycle={24} /></Labelled>
      </div>
    ),
  },
  {
    name: 'date-picker',
    title: 'Date picker and calendar',
    group: 'Dates and times',
    docs: ['DatePicker: label, value/defaultValue (CalendarDate), onChange — the calendar opens in a popover', 'MonthCalendar: value/defaultValue, onChange', 'The Android back action closes the open popover only', 'Weeks start on the locale’s first day'],
    demo: () => (
      <div className="flex flex-col gap-3">
        <MonthCalendar defaultValue={new CalendarDate(2026, 11, 25)} />
      </div>
    ),
    live: () => <DatePicker label="Start date" defaultValue={new CalendarDate(2026, 11, 25)} />,
  },
  {
    name: 'week-strip',
    title: 'Week strip',
    group: 'Dates and times',
    docs: ['value (CalendarDate), onChange', 'The week containing value, in the locale’s order; today is outlined'],
    demo: () => <WeekDemo />,
  },
  {
    name: 'cadence',
    title: 'Cadence picker',
    group: 'Dates and times',
    docs: [
      'value: Cadence, onChange(Cadence), label?',
      'Cadence: { kind: daily } | { kind: weekly, weekdays: 1–7 (ISO, Monday = 1) } | { kind: timesPerWeek, times: 1–6 } | { kind: monthly, day: 1–31 } | { kind: yearly, month: 1–12, day }',
      'Weekly has a switch: "On days" (weekdays, in the locale’s order, two-letter names; at least one stays chosen) or "Times a week" (1–6)',
      'Monthly: a grid of 1–30 and "Last day", which is day 31 in the value (every month-day past a month’s end means its last day)',
      'Yearly: twelve months, then the days of that month (29 for February); changing month shrinks the day to fit',
      'Tap only: no keyboard, no text entry. Every target is 44 px, and the grids fit 360 px',
      'Switching kinds and back keeps what was chosen; a new kind starts from today’s weekday, day or date',
      'Also exported by the dates helpers: isCadence(json), cadenceOfKind, LAST_DAY, maxDayOfMonth',
    ],
    demo: () => (
      <div className="flex flex-col gap-5">
        <CadenceDemo initial={{ kind: 'weekly', weekdays: [1, 4] }} label="On days" />
        <CadenceDemo initial={{ kind: 'timesPerWeek', times: 3 }} label="Times a week" />
        <CadenceDemo initial={{ kind: 'monthly', day: 31 }} label="Monthly" />
        <CadenceDemo initial={{ kind: 'yearly', month: 2, day: 29 }} label="Yearly" />
      </div>
    ),
  },
  {
    name: 'month-marks',
    title: 'Month marks',
    group: 'Dates and times',
    docs: [
      'marks: Record<ISO date, DayMark> — kept | short | skipped | missed | notDue | upcoming; a day with no entry is notDue',
      'Marks differ in shape as well as colour: filled check (kept), ring with check (short form), dash (skipped), cross (missed), nothing (not due), faint dot (upcoming)',
      'Each day is named like “November 26: kept” in the locale’s date format; markLabels? replaces the words (e.g. short: “kept, two-minute version”)',
      'month? (controlled) or defaultMonth? — any date in the month; onMonthChange(firstOfMonth) — previous and next month buttons are 44 px',
      'firstDayOfWeek?: mon | sun overrides the locale’s first day of the week (the second grid below is Monday-first, whatever the locale)',
      'Read-only: days are not buttons. Today’s number is outlined',
    ],
    demo: () => (
      <div className="flex flex-col gap-4">
        <MarksDemo />
        <Labelled label="firstDayOfWeek=&quot;mon&quot;"><MarksDemo firstDayOfWeek="mon" /></Labelled>
      </div>
    ),
  },
];

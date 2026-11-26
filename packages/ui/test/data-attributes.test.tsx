import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { Time, CalendarDate } from '@internationalized/date';
import {
  AppBar,
  Badge,
  Button,
  Callout,
  Card,
  CheckboxRow,
  EmptyState,
  Fab,
  IconButton,
  List,
  ListRow,
  ProgressBar,
  ProgressRing,
  SegmentedControl,
  Select,
  SwitchRow,
  TextArea,
  TextField,
  TimePicker,
  DatePicker,
  MonthCalendar,
  WeekStrip,
  CadencePicker,
} from '../src';

const hook = { 'data-hook': 'x1' } as const;

// Every kit component puts `data-*` attributes on its root element.
const cases: Array<[string, ReactElement]> = [
  ['Button', <Button {...hook}>b</Button>],
  ['TextField', <TextField label="t" {...hook} />],
  ['TextArea', <TextArea label="t" {...hook} />],
  ['Select', <Select label="s" options={[{ id: 'a', label: 'A' }]} {...hook} />],
  ['CheckboxRow', <CheckboxRow title="c" {...hook} />],
  ['SwitchRow', <SwitchRow title="s" {...hook} />],
  ['SegmentedControl', <SegmentedControl label="l" options={[{ id: 'a', label: 'A' }]} defaultValue="a" {...hook} />],
  ['Card', <Card {...hook}>c</Card>],
  ['List', <List {...hook}>c</List>],
  ['ListRow', <ListRow title="r" {...hook} />],
  ['EmptyState', <EmptyState title="e" {...hook} />],
  ['Badge', <Badge {...hook}>b</Badge>],
  ['ProgressBar', <ProgressBar label="p" value={1} {...hook} />],
  ['ProgressRing', <ProgressRing label="p" value={1} {...hook} />],
  ['Callout', <Callout {...hook}>c</Callout>],
  ['AppBar', <AppBar title="a" {...hook} />],
  ['Fab', <Fab label="f" onPress={() => {}} {...hook}>+</Fab>],
  ['IconButton', <IconButton label="i" {...hook}>+</IconButton>],
  ['TimePicker', <TimePicker label="t" defaultValue={new Time(8, 0)} {...hook} />],
  ['DatePicker', <DatePicker label="d" defaultValue={new CalendarDate(2026, 11, 25)} {...hook} />],
  ['MonthCalendar', <MonthCalendar defaultValue={new CalendarDate(2026, 11, 25)} {...hook} />],
  ['WeekStrip', <WeekStrip value={new CalendarDate(2026, 11, 25)} onChange={() => {}} {...hook} />],
  ['CadencePicker', <CadencePicker value={{ kind: 'daily' }} onChange={() => {}} {...hook} />],
];

describe('data attributes', () => {
  for (const [name, element] of cases) {
    it(`${name} passes data-* to the DOM`, () => {
      const html = renderToStaticMarkup(element);
      expect(html).toContain('data-hook="x1"');
    });
  }

  it('does not pass other unknown props', () => {
    expect(renderToStaticMarkup(<Button {...hook}>b</Button>)).not.toContain('variant');
  });
});

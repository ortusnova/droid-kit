// Reminders on the Platform tab: schedule test reminders, see what is
// scheduled, and which reminder opened the app.
import { useEffect, useState } from 'react';
import { cancel, capabilities, list, onReminderOpened, openSettings, schedule, type Capabilities, type Reminder } from '@droid-kit/reminders';
import { Button, Card } from '@droid-kit/ui';

const pad = (n: number) => String(n).padStart(2, '0');

function inMinutes(n: number) {
  const d = new Date(Date.now() + n * 60_000);
  return { date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, time: `${pad(d.getHours())}:${pad(d.getMinutes())}` };
}

export function RemindersSection() {
  const [items, setItems] = useState<Reminder[]>([]);
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [opened, setOpened] = useState<string>('none');
  const [openedCount, setOpenedCount] = useState(0);
  const [result, setResult] = useState<string>('');
  const [denied, setDenied] = useState(false);

  const refresh = async () => {
    const r = await list();
    if (r.ok) setItems(r.value);
  };

  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in globalThis)) return;
    void refresh();
    void capabilities().then(setCaps);
    // Debug builds: `js` can schedule any rule, e.g. `__dkRemind.schedule({ id: 'm', title: 't', body: 'b', repeat: { kind: 'monthly', day: 31, time: '09:00' } })`.
    if (window.__DK__?.debug) Object.assign(window, { __dkRemind: { schedule, cancel, list } });
    let stop: (() => void) | undefined;
    void onReminderOpened(id => {
      setOpened(id);
      setOpenedCount(n => n + 1);
    }).then(s => (stop = s));
    // Debug builds: `dk run linux-desktop --route '/?remind=2'` schedules the test reminder on start, for checks that cannot press a button.
    const remind = /[?&]remind=(\d+)/.exec(window.__DK__?.startRoute ?? '')?.[1];
    // `&daily=N` also schedules the test daily reminder, N minutes ahead.
    const daily = /[?&]daily=(\d+)/.exec(window.__DK__?.startRoute ?? '')?.[1];
    if (remind) {
      const at = inMinutes(Number(remind));
      void schedule({ id: 'test-once', title: 'droid-kit test', body: `Due at ${at.time}`, repeat: { kind: 'once', ...at } })
        .then(async r => {
          if (daily && r.ok) {
            const d = inMinutes(Number(daily));
            return schedule({ id: 'test-daily', title: 'droid-kit daily test', body: `Every day at ${d.time}`, repeat: { kind: 'daily', time: d.time } });
          }
          return r;
        })
        .then(r => {
          setResult(r.ok ? 'scheduled test reminders' : `error: ${JSON.stringify(r.error)}`);
          return refresh();
        });
    }
    return () => stop?.();
  }, []);

  const run = async (reminder: Reminder) => {
    const r = await schedule(reminder);
    setResult(r.ok ? `scheduled ${reminder.id}` : `error: ${JSON.stringify(r.error)}`);
    setDenied(!r.ok && r.error.kind === 'permission-denied');
    await refresh();
  };

  return (
    <Card title="Reminders">
      <p className="text-small text-muted" id="reminder-capabilities">
        {caps ? `${caps.platform}, can wake: ${caps.canWake}` : 'not in the app'}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          id="remind-2min"
          variant="primary"
          onPress={() => {
            const at = inMinutes(2);
            void run({ id: 'test-once', title: 'droid-kit test', body: `Due at ${at.time}`, repeat: { kind: 'once', ...at } });
          }}
        >
          In 2 minutes
        </Button>
        <Button
          id="remind-daily"
          onPress={() => {
            const at = inMinutes(2);
            void run({ id: 'test-daily', title: 'droid-kit daily test', body: `Every day at ${at.time}`, repeat: { kind: 'daily', time: at.time } });
          }}
        >
          Daily, from 2 minutes
        </Button>
        <Button
          id="remind-10min"
          onPress={() => {
            const at = inMinutes(10);
            void run({ id: 'test-restart', title: 'droid-kit restart test', body: `Due at ${at.time}`, repeat: { kind: 'once', ...at } });
          }}
        >
          In 10 minutes
        </Button>
        <Button
          id="remind-0630"
          onPress={() => void run({ id: 'test-0630', title: 'droid-kit 06:30', body: 'Every day at 06:30', repeat: { kind: 'daily', time: '06:30' } })}
        >
          Daily 06:30
        </Button>
        <Button
          id="remind-monthly"
          onPress={() => {
            const at = inMinutes(2);
            const day = Number(at.date.slice(8));
            void run({ id: 'test-monthly', title: 'droid-kit monthly test', body: `Day ${day} at ${at.time}`, repeat: { kind: 'monthly', day, time: at.time } });
          }}
        >
          Monthly, today in 2 min
        </Button>
        <Button
          id="remind-yearly"
          onPress={() => {
            const at = inMinutes(2);
            const [month, day] = [Number(at.date.slice(5, 7)), Number(at.date.slice(8))];
            void run({ id: 'test-yearly', title: 'droid-kit yearly test', body: `${month}/${day} at ${at.time}`, repeat: { kind: 'yearly', month, day, time: at.time } });
          }}
        >
          Yearly, today in 2 min
        </Button>
        <Button
          id="remind-weekly"
          onPress={() => void run({ id: 'test-weekly', title: 'droid-kit weekly', body: 'Monday and Thursday at 06:30', repeat: { kind: 'weekly', weekdays: [1, 4], time: '06:30' } })}
        >
          Mon and Thu 06:30
        </Button>
        <Button
          id="remind-cancel"
          variant="ghost"
          onPress={async () => {
            for (const r of items) await cancel(r.id);
            setResult('cancelled all');
            await refresh();
          }}
        >
          Cancel all
        </Button>
      </div>
      <p className="text-small" id="reminder-result">{result}</p>
      {denied && (
        <Button id="open-settings" onPress={() => void openSettings()}>
          Open settings
        </Button>
      )}
      <p className="text-small">
        Opened by: <span id="opened-id">{opened}</span> (<span id="opened-count">{openedCount}</span> times)
      </p>
      <ul className="text-small text-muted" id="reminder-list">
        {items.map(r => (
          <li key={r.id} data-reminder={r.id}>
            {r.id}: {JSON.stringify(r.repeat)}
          </li>
        ))}
      </ul>
    </Card>
  );
}

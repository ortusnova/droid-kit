// Reminders on the Platform tab: schedule test reminders, see what is
// scheduled, and which reminder opened the app.
import { useEffect, useState } from 'react';
import { cancel, capabilities, list, onReminderOpened, schedule, type Capabilities, type Reminder } from '@droid-kit/reminders';
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

  const refresh = async () => {
    const r = await list();
    if (r.ok) setItems(r.value);
  };

  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in globalThis)) return;
    void refresh();
    void capabilities().then(setCaps);
    let stop: (() => void) | undefined;
    void onReminderOpened(id => {
      setOpened(id);
      setOpenedCount(n => n + 1);
    }).then(s => (stop = s));
    return () => stop?.();
  }, []);

  const run = async (reminder: Reminder) => {
    const r = await schedule(reminder);
    setResult(r.ok ? `scheduled ${reminder.id}` : `error: ${JSON.stringify(r.error)}`);
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

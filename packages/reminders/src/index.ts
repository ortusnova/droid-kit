// Reminders: notifications at a local wall-clock time, delivered while the app
// is closed. Wraps the plugin's generated bindings.
import { addPluginListener } from '@tauri-apps/api/core';
import { commands, events, type Capabilities, type Reminder, type ReminderError, type Repeat } from './bindings';

export const VERSION = '0.1.0';
export type { Capabilities, Reminder, ReminderError, Repeat };

export type Result<T> = { ok: true; value: T } | { ok: false; error: ReminderError };

async function attempt<T>(run: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (e) {
    const error = (typeof e === 'object' && e && 'kind' in e ? e : { kind: 'platform', message: String(e) }) as ReminderError;
    return { ok: false, error };
  }
}

/**
 * The UTC offset, in minutes, of a local date and time in this device's time
 * zone. One-time reminders need it; repeating ones follow the device's clock.
 */
export function offsetAt(date: string, time: string): number {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  return -new Date(y, mo - 1, d, h, mi).getTimezoneOffset();
}

/**
 * Schedules a reminder, replacing any with the same id. The first time, this
 * asks for the notification permission; if refused, the result is
 * `{ ok: false, error: { kind: 'permission-denied' } }`.
 */
export function schedule(reminder: Reminder): Promise<Result<null>> {
  const offset = reminder.repeat.kind === 'once' ? offsetAt(reminder.repeat.date, reminder.repeat.time) : 0;
  return attempt(() => commands.schedule(reminder, offset));
}

export function cancel(id: string): Promise<Result<null>> {
  return attempt(() => commands.cancel(id));
}

export function list(): Promise<Result<Reminder[]>> {
  return attempt(() => commands.list());
}

/**
 * Opens the system's notification settings for this app, so the user can allow
 * notifications after `schedule` reported `permission-denied`. A no-op on Linux.
 */
export function openSettings(): Promise<Result<null>> {
  return attempt(() => commands.openSettings());
}

export function capabilities(): Promise<Capabilities> {
  return commands.capabilities();
}

/**
 * Calls `handler` with the id of a reminder whose notification the user
 * tapped: once at start-up if a tap started the app, and on each later tap.
 * Returns a function that stops listening.
 */
export async function onReminderOpened(handler: (id: string) => void): Promise<() => void> {
  // Linux and other platforms send the plugin's event; Android's Kotlin side
  // sends its own `tapped` event for a tap while the app runs.
  const stop = await events.reminderOpened.listen(e => handler(e.payload.id));
  const android = await addPluginListener<{ id: string }>('droid-kit-reminders', 'tapped', e => handler(e.id)).catch(() => undefined);
  const atStart = await commands.takeOpened();
  if (atStart) handler(atStart);
  return () => {
    stop();
    void android?.unregister();
  };
}

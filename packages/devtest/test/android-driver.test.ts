import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TestContext } from '../src/index.js';
import { createDriver } from '../src/drivers/android.js';
import { findExpander, findTitle, inputText, javaHash, matches, notificationId, parseNotifications, parseUiNodes } from '../src/drivers/android-parse.js';

const PKG = 'com.ortusnova.droidkit.gallery';

// What `dumpsys notification --noredact` prints for the reminders the plugin posted (real output, trimmed).
const DUMP = `
  Notification List:
    NotificationRecord(0x0e3f9503: pkg=${PKG} user=UserHandle{0} id=0 tag=0|${PKG}|g:Aggregate_AlertingSection importance=4 key=0|${PKG}|0|0|10197: Notification(channel=dk-reminders flags=GROUP_SUMMARY|AUTOGROUP_SUMMARY))
      extras={
            when=1795709520539/1795709520539
    NotificationRecord(0x0dddb6fe: pkg=${PKG} user=UserHandle{0} id=2054848580 tag=null importance=4 key=0|${PKG}|2054848580|null|10197: Notification(channel=dk-reminders category=reminder vis=PRIVATE))
      extras={
                android.title=String (verify swipe-daily)
                android.text=String (Daily at 09:12)
    NotificationRecord(0x0c9cf0ac: pkg=${PKG} user=UserHandle{0} id=-1180300554 tag=null importance=4 key=0|${PKG}|-1180300554|null|10197: Notification(channel=dk-reminders category=reminder vis=PRIVATE))
      extras={
                android.title=String (verify swipe-once)
                android.text=String (Due at 09:12)
    NotificationRecord(0x01: pkg=com.android.settings user=UserHandle{0} id=7 tag=null importance=2: Notification(channel=adb))
      extras={
                android.title=String (Wireless debugging connected)
`;

describe('the parts of the Android driver that need no device', () => {
  it('knows the notification id the plugin gives a reminder (Java String.hashCode)', () => {
    expect(notificationId('swipe-daily')).toBe(2054848580);
    expect(notificationId('swipe-once')).toBe(-1180300554);
    expect(javaHash('')).toBe(0);
    expect(javaHash('Aa')).toBe(javaHash('BB'));
  });

  it("lists one package's shown notifications and skips the group summary and other apps", () => {
    const shown = parseNotifications(DUMP, PKG);
    expect(shown.map(n => n.title)).toEqual(['verify swipe-daily', 'verify swipe-once']);
    expect(shown[0]).toEqual({ id: 2054848580, title: 'verify swipe-daily', text: 'Daily at 09:12' });
  });

  it('matches by reminder id, by title, or both; an empty match matches nothing', () => {
    const [daily] = parseNotifications(DUMP, PKG);
    expect(matches(daily, { id: 'swipe-daily' })).toBe(true);
    expect(matches(daily, { id: 'swipe-once' })).toBe(false);
    expect(matches(daily, { title: 'verify swipe-daily' })).toBe(true);
    expect(matches(daily, { id: 'swipe-daily', title: 'other' })).toBe(false);
    expect(matches(daily, {})).toBe(false);
  });

  it('types plain text with %s for spaces and refuses what `input text` cannot take', () => {
    expect(inputText('Evening walk')).toBe('Evening%swalk');
    expect(inputText('a.b,c:d;e@f_g/h+i=j-k 9')).toBe('a.b,c:d;e@f_g/h+i=j-k%s9');
    expect(() => inputText("it's")).toThrow(/cannot type "'"/);
    expect(() => inputText('café')).toThrow(/cannot type "é"/);
    expect(inputText('Read (daily) & "more"')).toBe('Read%s(daily)%s&%s"more"');
    expect(() => inputText('100%')).toThrow(/cannot type "%"/);
  });

  it('finds a notification in the shade, and the header that expands its group', () => {
    const nodes = parseUiNodes(readFileSync(join(import.meta.dirname, 'shade-collapsed.xml'), 'utf8'));
    const g1 = findTitle(nodes, 'verify g1');
    expect(g1).toMatchObject({ text: 'verify g1', x: 418, y: 1162 });
    expect(findTitle(nodes, 'verify nothing')).toBeNull();
    // The group's header is above the rows; the other notification's chevron (below them) is not it.
    expect(findExpander(nodes, g1!.y)).toMatchObject({ desc: 'Expand', x: 1274, y: 888 });
    expect(findExpander(nodes, 880)).toBeNull();
  });
});

describe('the Android driver against a fake adb', () => {
  let dir: string;
  let log: string;
  let context: TestContext;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dk-android-'));
    log = join(dir, 'calls.log');
    const dump = join(dir, 'dump.txt');
    writeFileSync(dump, DUMP);
    // A stand-in adb: lists one phone, answers `pidof`, `dumpsys notification` and `screencap`, and records every call.
    writeFileSync(
      join(dir, 'adb'),
      `#!/usr/bin/env bash
echo "$*" >> ${log}
args="$*"
case "$args" in
  devices) printf 'List of devices attached\\n192.168.1.5:40000\\tdevice\\n' ;;
  *"dumpsys notification"*) cat ${dump} ;;
  *screencap*) head -c 4000 /dev/zero ;;
  *pidof*) echo 1234 ;;
esac
`,
    );
    chmodSync(join(dir, 'adb'), 0o755);
    context = {
      target: 'android-phone',
      appDir: dir,
      identifier: PKG,
      androidPackage: PKG,
      binary: 'gallery',
      artifacts: dir,
      runDir: join(dir, 'run'),
      dk: 'dk',
      android: { adb: join(dir, 'adb'), host: 'nowhere', hostRoot: '/nowhere', phone: undefined },
      linux: { image: '' },
    };
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const calls = () => readFileSync(log, 'utf8').trim().split('\n');

  it('declares real touch and the phone capabilities, without the clock', async () => {
    const d = await createDriver(context);
    expect(d.inputLabel).toBe('real touch (adb shell input)');
    expect([...d.capabilities].sort()).toEqual(['notifications', 'realInput', 'reinstall']);
    await d.close();
  });

  it('talks to the one wireless-debugging phone, and wakes it first', async () => {
    const d = await createDriver(context);
    await d.close();
    expect(calls()[0]).toBe('devices');
    expect(calls().some(c => c.startsWith('-s 192.168.1.5:40000 shell input keyevent KEYCODE_WAKEUP'))).toBe(true);
  });

  it('sends the back key, stops the app, and saves a screenshot', async () => {
    const d = await createDriver(context);
    await d.back();
    await d.forceStop();
    const shot = await d.screenshot('first');
    await d.close();
    expect(calls()).toContain('-s 192.168.1.5:40000 shell input keyevent KEYCODE_BACK');
    expect(calls()).toContain(`-s 192.168.1.5:40000 shell am force-stop ${PKG}`);
    expect(shot).toBe(join(context.runDir, 'first.png'));
    expect(readFileSync(shot).length).toBe(4000);
  });

  it('waits for a notification by id or title, and says what is shown when there is none', async () => {
    const d = await createDriver(context);
    await d.waitForNotification({ id: 'swipe-once' });
    await d.waitForNotification({ title: 'verify swipe-daily' });
    await expect(d.waitForNotification({ id: 'nothing' }, { timeoutMs: 600 })).rejects.toThrow(/no notification for {"id":"nothing"}.*verify swipe-daily/);
    await d.close();
  });

  it('refuses to type what it cannot type, before touching anything', async () => {
    const d = await createDriver(context);
    await expect(d.type('#name', "it's")).rejects.toThrow(/printable ASCII/);
    await d.close();
  });
});

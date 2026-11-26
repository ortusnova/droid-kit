// Keyboard checks on desktop (ui-components spec "Accessible behaviour"), in
// headless Chromium with real key events: Escape closes an overlay and focus
// returns to the control that opened it.
//
//   node scripts/desktop-keys.mjs   (needs the gallery's `vite preview` on port 5330)
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = 'http://127.0.0.1:5330';
const CDP = 9361;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), 'keys-'));
const chrome = spawn('chromium-browser', ['--headless=new', '--disable-gpu', '--no-first-run', `--user-data-dir=${profile}`, `--remote-debugging-port=${CDP}`, 'about:blank'], { stdio: 'ignore' });
let failures = 0;
try {
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    await sleep(200);
    target = await fetch(`http://127.0.0.1:${CDP}/json`).then(r => r.json()).then(l => l.find(t => t.type === 'page')).catch(() => undefined);
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r, { once: true }));
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const send = (method, params = {}) => new Promise(r => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
  const evaluate = async expression => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
  const key = async (key, code, vk) => {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk });
  };
  await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
  const check = async (name, path, trigger, openSelector) => {
    await send('Page.navigate', { url: BASE + path });
    await sleep(1500);
    await evaluate(`document.querySelector('${trigger}').focus()`);
    await key('Enter', 'Enter', 13);
    await sleep(1200);
    const opened = await evaluate(`!!document.querySelector('${openSelector}')`);
    const focusInside = await evaluate(`!!document.activeElement.closest('${openSelector}')`);
    await key('Escape', 'Escape', 27);
    await sleep(1500);
    const closed = await evaluate(`!document.querySelector('${openSelector}')`);
    const returned = await evaluate(`document.activeElement === document.querySelector('${trigger}')`);
    const ok = opened && focusInside && closed && returned;
    if (!ok) failures++;
    console.error(`${ok ? 'ok' : 'FAIL'}: ${name}: opened by Enter ${opened}, focus moved inside ${focusInside}, closed by Escape ${closed}, focus back on the trigger ${returned}`);
  };
  await check('sheet from the floating action button', '/components/sheet', '[data-live] button[aria-label="New habit"]', '.dk-sheet');
  await check('sheet from a button', '/components/sheet', '#open-sheet', '.dk-sheet');
  await check('confirm dialog', '/components/confirm-dialog', '#open-confirm', '[role=alertdialog]');
  ws.close();
} finally {
  chrome.kill();
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
}
process.exitCode = failures ? 1 : 0;

// The Android driver (`dk test android-phone` and `dk test android-emulator`).
//
// - Input is real touch: `adb shell input tap` and `swipe` at the middle of the element,
//   from its `getBoundingClientRect` times the device pixel ratio (the window is edge to
//   edge, so the web view's offset on the screen is 0). Typing is `adb shell input text`.
//   This generalises scripts/phone.sh.
// - The page is read and driven through the WebView's DevTools socket (`adb forward`).
// - Scrolling to reach an element moves only a scroll container (a sheet's content, or the
//   app's main area), never the document: scrolling the document shifts the whole app
//   shell. Tab-bar links and the like are fixed, so they are tapped where they are.
// - Screenshots are `screencap`: the phone shows only the app.
// - Notifications: `dumpsys notification` says what is shown; a tap is found in the shade
//   with `uiautomator dump`.
// - Everything that talks to the device goes through a bridge (android-bridge.js) that runs
//   where adb and the DevTools forwards are: here for the phone, and inside the build host's
//   container for the emulator (`ssh <host> apodman exec -i …`), as /opt/models/android-dev/work/emu.sh does.
// - The clock and the time zone can be set on the emulator only (`setClock`, `setZone`); `close()`
//   puts them back (automatic time and zone on, the zone as it was).

import { execFile, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { findExpander, findTitle, inputText, matches, parseNotifications, parseUiNodes } from './android-parse.js';

const run = promisify(execFile);
const sleep = (/** @type {number} */ ms) => new Promise(resolve => setTimeout(resolve, ms));

/** @typedef {import('../index.js').Driver} Driver */
/** @typedef {import('../index.js').NotificationMatch} NotificationMatch */

const BRIDGE = fileURLToPath(new URL('./android-bridge.js', import.meta.url));

// ---- what runs inside the page -------------------------------------------------------------

/** Installed once per page (`window.__dkTest`). Plain JavaScript: it is sent as text. */
function pageHelpers() {
  const frame = () => new Promise(resolve => requestAnimationFrame(() => resolve(undefined)));

  /** @param {string} selector */
  const find = selector => {
    const el = document.querySelector(selector);
    if (!el) throw new Error(`no element matches ${selector}`);
    return /** @type {HTMLElement} */ (el);
  };

  /** The visible height of the page: the keyboard, if open, takes its share. */
  const visibleHeight = () => window.visualViewport?.height ?? innerHeight;

  /**
   * Scrolls the element's scroll container (never the document) until the element's middle is in its visible part.
   * @param {HTMLElement} el
   */
  const reveal = async el => {
    const scroller = el.closest('.dk-sheet-content') ?? (() => {
      const main = document.querySelector('[data-scroll-restoration-id="main"]');
      return main && main.contains(el) ? main : null;
    })();
    if (!scroller) return;
    const r = el.getBoundingClientRect();
    const s = scroller.getBoundingClientRect();
    const top = Math.max(s.top, 0);
    const bottom = Math.min(s.bottom, visibleHeight());
    const middle = r.top + r.height / 2;
    if (middle >= top + 8 && middle <= bottom - 8) return;
    scroller.scrollBy({ top: middle - (top + bottom) / 2, behavior: 'instant' });
    await frame();
    await frame();
  };

  return {
    /** Where a finger would go for this selector, after revealing it; `covered` says what is in the way, if anything. */
    async geometry(/** @type {string} */ selector) {
      const el = find(selector);
      const pause = (/** @type {number} */ ms) => new Promise(resolve => setTimeout(resolve, ms));
      // A sheet that is still sliding in, or a list still settling after a scroll, moves: wait until the element stays put and is on the screen.
      /** @type {DOMRect | null} */
      let last = null;
      /** @type {DOMRect} */
      let r = el.getBoundingClientRect();
      for (let i = 0; i < 15; i++) {
        await reveal(el);
        r = el.getBoundingClientRect();
        const still = last !== null && Math.abs(r.top - last.top) < 1 && Math.abs(r.left - last.left) < 1;
        const onScreen = r.width > 0 && r.height > 0 && r.left + r.width / 2 >= 0 && r.left + r.width / 2 <= innerWidth && r.top + r.height / 2 >= 0 && r.top + r.height / 2 <= innerHeight;
        if (still && onScreen) break;
        last = r;
        await pause(100);
      }
      if (r.width === 0 || r.height === 0) throw new Error(`${selector} has no size, so it cannot be touched`);
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) throw new Error(`${selector} is not on the screen at (${Math.round(x)}, ${Math.round(y)})`);
      const top = document.elementFromPoint(x, y);
      /** @type {string | null} */
      let covered = null;
      if (!top) covered = 'nothing';
      else if (!(el.contains(top) || top.contains(el))) covered = `${top.tagName.toLowerCase()}${top.className ? `.${String(top.className).trim().split(/\s+/).join('.')}` : ''}`;
      return { x, y, dpr: devicePixelRatio, innerWidth, innerHeight, covered };
    },

    /** Whether the element (or what it points at) has the focus. */
    focused(/** @type {string} */ selector) {
      const el = document.querySelector(selector);
      return Boolean(el && (el === document.activeElement || el.contains(document.activeElement)));
    },

    /** Go to a route inside the app, as a link would: a new history entry, and the router told. */
    async open(/** @type {string} */ route) {
      const state = /** @type {Record<string, unknown> | null} */ (history.state) ?? {};
      /** @type {Record<string, unknown>} */
      const next = { ...state, key: Math.random().toString(36).slice(2) };
      if (typeof state.__TSR_index === 'number') next.__TSR_index = state.__TSR_index + 1;
      history.pushState(next, '', route);
      dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
      await frame();
      return location.pathname + location.search;
    },
  };
}

/** The expression that calls a page helper, installing the helpers first if the page is new. */
const helper = (/** @type {string} */ name, /** @type {unknown[]} */ args) => `(window.__dkTest ??= (${pageHelpers.toString()})()).${name}(...${JSON.stringify(args)})`;

/** The page has rendered something. */
const PAGE_READY = `document.readyState === 'complete' && Boolean(document.querySelector('#root')) && document.querySelector('#root').children.length > 0`;

// ---- the bridge ----------------------------------------------------------------------------

class Bridge {
  /** @param {import('node:child_process').ChildProcessWithoutNullStreams} child */
  constructor(child) {
    this.child = child;
    this.next = 0;
    /** @type {Map<number, { resolve: (m: any) => void, reject: (e: Error) => void }>} */
    this.pending = new Map();
    this.buffer = '';
    this.stderr = '';
    child.stdout.on('data', d => this.#data(String(d)));
    child.stderr.on('data', d => (this.stderr = (this.stderr + d).slice(-2000)));
    child.on('close', code => {
      for (const w of this.pending.values()) w.reject(new Error(`the bridge to the device ended (exit ${code}): ${this.stderr.trim().split('\n').slice(-3).join(' | ')}`));
      this.pending.clear();
    });
  }

  /** @param {string} chunk */
  #data(chunk) {
    this.buffer += chunk;
    for (let i = this.buffer.indexOf('\n'); i >= 0; i = this.buffer.indexOf('\n')) {
      const line = this.buffer.slice(0, i);
      this.buffer = this.buffer.slice(i + 1);
      let reply;
      try {
        reply = JSON.parse(line);
      } catch {
        continue;
      }
      const waiter = this.pending.get(reply.id);
      if (!waiter) continue;
      this.pending.delete(reply.id);
      if (reply.ok) waiter.resolve(reply);
      else waiter.reject(new Error(reply.error));
    }
  }

  /** @param {Record<string, unknown>} body @param {number} [timeoutMs] @returns {Promise<any>} */
  request(body, timeoutMs = 90_000) {
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`no answer from the device bridge within ${timeoutMs} ms (${JSON.stringify(body).slice(0, 120)})`));
      }, timeoutMs);
      this.pending.set(id, { resolve: m => (clearTimeout(timer), resolve(m)), reject: e => (clearTimeout(timer), reject(e)) });
      this.child.stdin.write(`${JSON.stringify({ id, ...body })}\n`);
    });
  }

  close() {
    this.child.stdin.end();
    setTimeout(() => this.child.kill(), 500).unref();
  }
}

// ---- the driver ----------------------------------------------------------------------------

/** The phone's adb serial: the configured address, else the wireless-debugging device adb lists. @param {import('../index.js').TestContext} context */
async function findPhone(context) {
  const adb = context.android.adb;
  const { stdout } = await run(adb, ['devices']);
  const listed = stdout.split('\n').slice(1).map(l => l.split(/\s+/)).filter(p => p[1] === 'device').map(p => p[0]);
  const wanted = context.android.phone;
  if (wanted && listed.includes(wanted)) return wanted;
  if (wanted) {
    const { stdout: out } = await run(adb, ['connect', wanted]);
    if (/connected/.test(out)) return wanted;
  }
  const byAddress = listed.find(s => /^\d+\.\d+\.\d+\.\d+:\d+$/.test(s)) ?? listed[0];
  if (!byAddress) throw new Error('no phone is connected to adb: turn on Wireless debugging (dk doctor says how)');
  return byAddress;
}

/** @type {import('../index.js').CreateDriver} */
export async function createDriver(context) {
  const emulator = context.target === 'android-emulator';
  const pkg = context.androidPackage;
  mkdirSync(context.runDir, { recursive: true });

  /** @type {Bridge} */
  let bridge;
  if (emulator) {
    const code = Buffer.from(readFileSync(BRIDGE, 'utf8')).toString('base64');
    const root = context.android.hostRoot;
    const command = `cd ${root} && bin/apodman exec -i -e ANDROID_DEV_ROOT=${root} android-dev-emulator android-dev-entrypoint node --input-type=module -e "import('data:text/javascript;base64,${code}')"`;
    bridge = new Bridge(spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', context.android.host, command], { stdio: ['pipe', 'pipe', 'pipe'] }));
    await bridge.request({ op: 'init', adb: 'adb', serial: null }, 30_000);
  } else {
    const serial = await findPhone(context);
    bridge = new Bridge(spawn(process.execPath, [BRIDGE], { stdio: ['pipe', 'pipe', 'pipe'] }));
    await bridge.request({ op: 'init', adb: context.android.adb, serial }, 30_000);
  }

  /** @param {string[]} args @param {{ timeoutMs?: number, binary?: boolean }} [options] */
  const adb = async (args, options = {}) => (await bridge.request({ op: 'adb', args, ...options }, (options.timeoutMs ?? 60_000) + 10_000)).stdout;
  /** One command in the device's shell. @param {string} command */
  const shell = command => adb(['shell', command]);
  /** @param {string} expression @param {number} [timeoutMs] @returns {Promise<any>} */
  const evaluate = async (expression, timeoutMs = 30_000) => (await bridge.request({ op: 'eval', pkg, expression, timeoutMs }, timeoutMs + 10_000)).value;

  let lastAction = 0;
  /** Wakes the phone, lifts the keyguard (the phone has no PIN) and closes the notification shade: a sleeping screen or an open shade swallows taps. */
  const awake = async () => {
    await shell('input keyevent KEYCODE_WAKEUP; wm dismiss-keyguard; cmd statusbar collapse');
    lastAction = Date.now();
  };
  /** Before input: wake the screen again if nothing has touched it for a while. */
  const ensureAwake = async () => {
    if (Date.now() - lastAction > 45_000) await awake();
    lastAction = Date.now();
  };

  /** @param {string} selector */
  const geometry = async selector => {
    const g = await evaluate(helper('geometry', [selector]));
    if (g.covered) throw new Error(`the middle of ${selector} is covered by ${g.covered}`);
    return /** @type {{ x: number, y: number, dpr: number, innerWidth: number, innerHeight: number }} */ (g);
  };

  /** @param {{ timeoutMs?: number }} [options] */
  const waitReady = async (options = {}) => {
    const until = Date.now() + (options.timeoutMs ?? 40_000);
    let last = '';
    for (;;) {
      try {
        if (await evaluate(PAGE_READY, 5000)) return;
        last = 'the page is empty';
      } catch (e) {
        last = e instanceof Error ? e.message : String(e);
      }
      if (Date.now() > until) throw new Error(`the app's page did not come up (${last})`);
      await sleep(400);
    }
  };

  /** @param {string} command @param {string[]} args */
  const spawnDk = (command, args) =>
    new Promise((resolve, reject) => {
      const child = spawn(command, args, { cwd: context.appDir, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', d => (output += d));
      child.stderr.on('data', d => (output += d));
      child.on('error', reject);
      child.on('close', code => (code === 0 ? resolve(output) : reject(new Error(`dk ${args.join(' ')} exited ${code}: ${output.trim().split('\n').slice(-6).join(' | ')}`))));
    });

  const shown = async () => parseNotifications(await adb(['shell', 'dumpsys', 'notification', '--noredact']), pkg);

  /** The UI hierarchy of the screen, as `uiautomator dump` writes it. */
  const uiDump = async () => {
    await adb(['shell', 'uiautomator dump /data/local/tmp/dk-ui.xml >/dev/null 2>&1']);
    const xml = await adb(['exec-out', 'cat', '/data/local/tmp/dk-ui.xml']);
    return xml;
  };

  /** @type {{ autoTime: string, autoZone: string, zone: string } | null} */
  let clockBefore = null;
  const noteClock = async () => {
    if (!emulator) throw new Error('the clock can be set on the emulator only');
    if (clockBefore) return;
    const [autoTime, autoZone, zone] = (await shell('settings get global auto_time; settings get global auto_time_zone; getprop persist.sys.timezone')).trim().split('\n').map((/** @type {string} */ s) => s.trim());
    clockBefore = { autoTime, autoZone, zone };
  };

  /** @type {Driver & { setClock?: (epochMs: number) => Promise<void>, setZone?: (zone: string) => Promise<void>, beforeScenario(name: string): Promise<void> }} */
  const driver = {
    target: context.target,
    capabilities: new Set(emulator ? ['realInput', 'notifications', 'reinstall', 'clock'] : ['realInput', 'notifications', 'reinstall']),
    inputLabel: 'real touch (adb shell input)',

    async beforeScenario() {
      await awake();
    },

    async open(route) {
      await evaluate(helper('open', [route]));
    },

    async tap(selector) {
      await ensureAwake();
      const g = await geometry(selector);
      await shell(`input tap ${Math.round(g.x * g.dpr)} ${Math.round(g.y * g.dpr)}`);
      await sleep(150);
    },

    async swipe(selector, direction) {
      await ensureAwake();
      const g = await geometry(selector);
      const x = Math.round(g.x * g.dpr);
      const y = Math.round(g.y * g.dpr);
      const vertical = direction === 'up' || direction === 'down';
      const distance = Math.round((vertical ? g.innerHeight : g.innerWidth) * g.dpr * 0.4);
      const sign = direction === 'down' || direction === 'right' ? 1 : -1;
      const [x2, y2] = vertical ? [x, y + sign * distance] : [x + sign * distance, y];
      await shell(`input swipe ${x} ${y} ${Math.max(0, x2)} ${Math.max(0, y2)} 350`);
      await sleep(250);
    },

    async type(selector, text) {
      const keys = inputText(text);
      await driver.tap(selector);
      const until = Date.now() + 5000;
      while (!(await evaluate(helper('focused', [selector])))) {
        if (Date.now() > until) throw new Error(`${selector} did not take the focus when it was touched`);
        await sleep(150);
      }
      await sleep(400);
      await shell(`input text '${keys}'`);
      await sleep(300);
    },

    async back() {
      await ensureAwake();
      await shell('input keyevent KEYCODE_BACK');
      await sleep(250);
    },

    eval: /** @type {Driver['eval']} */ (expression => evaluate(expression)),

    async waitFor(expression, options = {}) {
      const until = Date.now() + (options.timeoutMs ?? 10_000);
      let last = '';
      for (;;) {
        try {
          if (await evaluate(`Boolean(${expression.trim().replace(/;$/, '')}\n)`, 5000)) return;
          last = 'it was false';
        } catch (e) {
          last = e instanceof Error ? e.message : String(e);
        }
        if (Date.now() > until) throw new Error(`timed out waiting for ${expression} (${last})`);
        await sleep(150);
      }
    },

    async screenshot(name) {
      const path = join(context.runDir, `${name}.png`);
      const png = Buffer.from(await adb(['exec-out', 'screencap', '-p'], { binary: true }), 'base64');
      if (png.length < 1000) throw new Error('the screenshot came back empty (is the screen on?)');
      writeFileSync(path, png);
      return path;
    },

    async forceStop() {
      await shell(`am force-stop ${pkg}`);
      await sleep(300);
    },

    async restart() {
      await awake();
      await shell(`am force-stop ${pkg}`);
      await shell(`am start -n ${pkg}/.MainActivity`);
      await waitReady();
    },

    async reinstall() {
      await awake();
      await spawnDk(context.dk, ['run', context.target]);
      await awake();
      await waitReady();
    },

    async waitForNotification(match, options = {}) {
      const until = Date.now() + (options.timeoutMs ?? 10_000);
      for (;;) {
        if ((await shown()).some(n => matches(n, match))) return;
        if (Date.now() > until) throw new Error(`no notification for ${JSON.stringify(match)} (shown: ${JSON.stringify((await shown()).map(n => n.title))})`);
        await sleep(500);
      }
    },

    async tapNotification(match) {
      const found = (await shown()).find(n => matches(n, match));
      if (!found) throw new Error(`no notification for ${JSON.stringify(match)} to tap`);
      await awake();
      await shell('cmd statusbar expand-notifications');
      await sleep(1200);
      let xml = '';
      let expanded = false;
      for (let attempt = 0; attempt < 4; attempt++) {
        xml = await uiDump();
        const nodes = parseUiNodes(xml);
        const target = findTitle(nodes, found.title);
        if (target) {
          // A collapsed group of notifications is one view: a tap on it opens the app without the tapped reminder.
          // Expand the group first, then tap the notification's own row.
          const header = expanded ? null : findExpander(nodes, target.y);
          if (header) {
            await shell(`input tap ${header.x} ${header.y}`);
            expanded = true;
            await sleep(900);
            continue;
          }
          await shell(`input tap ${target.x} ${target.y}`);
          // The app may have to start; its first page is what the scenario waits for next.
          await sleep(1500);
          return;
        }
        await sleep(600);
      }
      writeFileSync(join(context.runDir, 'shade.xml'), xml);
      throw new Error(`the notification "${found.title}" is not in the shade (the screen's nodes are in shade.xml)`);
    },

    async close() {
      try {
        if (clockBefore) {
          // Automatic time first (the clock returns to the network's), then the zone as it was.
          await shell(`settings put global auto_time ${clockBefore.autoTime || 1}; settings put global auto_time_zone ${clockBefore.autoZone || 1}`);
          await sleep(3000);
          await shell(`cmd alarm set-timezone ${clockBefore.zone}`);
        }
        await shell('rm -f /data/local/tmp/dk-ui.xml');
      } finally {
        bridge.close();
      }
    },
  };

  if (emulator) {
    // The clock and the time zone: the emulator only. `close()` puts them back.
    driver.setClock = async epochMs => {
      await noteClock();
      await shell(`settings put global auto_time 0; cmd alarm set-time ${Math.round(epochMs)}`);
    };
    driver.setZone = async zone => {
      await noteClock();
      await shell(`settings put global auto_time_zone 0; cmd alarm set-timezone ${zone}`);
    };
  }

  await awake();
  return driver;
}

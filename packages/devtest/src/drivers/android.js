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

  /**
   * The part of the page the screen shows, in the page's coordinates. The keyboard does not resize the layout viewport:
   * it shrinks the visual viewport and moves it down the page, so what a finger touches is `rect - offset`.
   */
  const visible = () => {
    const v = window.visualViewport;
    return { left: v?.offsetLeft ?? 0, top: v?.offsetTop ?? 0, width: v?.width ?? innerWidth, height: v?.height ?? innerHeight };
  };

  /**
   * The nearest container the element scrolls in: a sheet's content (which scrolls although its overflow is hidden), or an
   * ancestor with scrollable overflow (the app's main area, a list in a popover). Never the document.
   * @param {HTMLElement} el
   */
  const scrollerOf = el => {
    for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
      if (p.matches('.dk-sheet-content')) return p;
      const overflow = getComputedStyle(p).overflowY;
      if ((overflow === 'auto' || overflow === 'scroll') && p.scrollHeight > p.clientHeight + 1) return p;
    }
    return null;
  };

  /**
   * Scrolls the element's scroll container (never the document) until the element's middle is in its visible part.
   * With `place` (0 to 1) it goes to that fraction of the visible part, whatever it is now: a way out from under a fixed
   * control (the sheet's handle, the floating action button, the tab bar).
   * @param {HTMLElement} el @param {number} [place]
   */
  const reveal = async (el, place) => {
    const scroller = scrollerOf(el);
    if (!scroller) return;
    const r = el.getBoundingClientRect();
    const s = scroller.getBoundingClientRect();
    const v = visible();
    const top = Math.max(s.top, v.top);
    const bottom = Math.min(s.bottom, v.top + v.height);
    const middle = r.top + r.height / 2;
    if (place === undefined && middle >= top + 8 && middle <= bottom - 8) return;
    scroller.scrollBy({ top: middle - (top + (bottom - top) * (place ?? 0.5)), behavior: 'instant' });
    await frame();
    await frame();
  };

  /** What a finger at the element's middle would land on, if that is not the element: a description, or null. */
  const coveredBy = (/** @type {HTMLElement} */ el) => {
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (!top) return 'nothing';
    if (el.contains(top) || top.contains(el)) return null;
    return `${top.tagName.toLowerCase()}${top.className ? `.${String(top.className).trim().split(/\s+/).join('.')}` : ''}`;
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
        const v = visible();
        const onScreen = r.width > 0 && r.height > 0 && r.left + r.width / 2 >= v.left && r.left + r.width / 2 <= v.left + v.width && r.top + r.height / 2 >= v.top && r.top + r.height / 2 <= v.top + v.height;
        if (still && onScreen) break;
        last = r;
        await pause(100);
      }
      if (r.width === 0 || r.height === 0) throw new Error(`${selector} has no size, so it cannot be touched`);
      // Under a fixed control: scroll it to other places in its container until a finger would land on it.
      for (const place of coveredBy(el) ? [0.3, 0.7, 0.15, 0.85] : []) {
        await reveal(el, place);
        await pause(80);
        r = el.getBoundingClientRect();
        if (!coveredBy(el)) break;
      }
      const v = visible();
      const x = r.left + r.width / 2 - v.left;
      const y = r.top + r.height / 2 - v.top;
      if (x < 0 || y < 0 || x > v.width || y > v.height) throw new Error(`${selector} is not on the screen at (${Math.round(x)}, ${Math.round(y)}) of ${Math.round(v.width)} by ${Math.round(v.height)}`);
      return { x, y, dpr: devicePixelRatio, innerWidth: v.width, innerHeight: v.height, covered: coveredBy(el) };
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
  const evaluate = async (expression, timeoutMs = 30_000) => {
    for (let attempt = 1; ; attempt++) {
      try {
        return (await bridge.request({ op: 'eval', pkg, expression, timeoutMs }, timeoutMs + 10_000)).value;
      } catch (e) {
        // The page's script context went away while the call was waiting (the page was loading or reloaded): the answer is lost, the question can be asked again.
        if (attempt < 3 && /Promise was collected|context was destroyed|Cannot find context/i.test(e instanceof Error ? e.message : String(e))) {
          await sleep(1000);
          continue;
        }
        throw e;
      }
    }
  };

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

  /** @type {Driver & { killProcess(): Promise<void>, keyboardShown(): Promise<boolean>, hideKeyboard(): Promise<boolean>, setClock?: (epochMs: number) => Promise<void>, setZone?: (zone: string) => Promise<void>, beforeScenario(name: string): Promise<void> }} */
  const driver = {
    target: context.target,
    capabilities: new Set(emulator ? ['realInput', 'notifications', 'reinstall', 'clock'] : ['realInput', 'notifications', 'reinstall']),
    inputLabel: 'real touch (adb shell input)',

    async beforeScenario() {
      await awake();
      // The last scenario may have left the app behind (Back from its first screen, a system prompt, a stopped process): a page that is not on the screen does not answer.
      const resumed = await shell('dumpsys activity activities | grep -m1 -E "topResumedActivity|mResumedActivity"');
      if (!resumed.includes(pkg)) await driver.restart();
      else await driver.hideKeyboard();
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
      // A touch puts the caret where it landed; typing here continues the text, as the other drivers do.
      await evaluate(`(() => { const el = document.activeElement; if (el && typeof el.value === 'string' && el.setSelectionRange) try { el.setSelectionRange(el.value.length, el.value.length); } catch {} return true; })()`);
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

    async killProcess() {
      await ensureAwake();
      // `am kill` ends only a process that is in the background; Home first. Unlike a force-stop it keeps the app's alarms, as the system's own kill does.
      await shell('input keyevent KEYCODE_HOME');
      // The app counts as in the background a moment after Home (longer on the emulator); until then am kill leaves it alone.
      const until = Date.now() + 15_000;
      for (;;) {
        await sleep(800);
        await shell(`am kill ${pkg}`);
        await sleep(400);
        if (!(await shell(`pidof ${pkg}`)).trim()) return;
        if (Date.now() > until) throw new Error(`${pkg} is still running 15 s after Home and am kill`);
      }
    },

    async keyboardShown() {
      return (await shell('dumpsys input_method | grep -m1 mInputShown')).includes('mInputShown=true');
    },

    async hideKeyboard() {
      if (!(await driver.keyboardShown())) return false;
      await ensureAwake();
      // Back goes to the keyboard first: it closes, and the sheet or screen under it stays.
      await shell('input keyevent KEYCODE_BACK');
      const until = Date.now() + 4000;
      while (Date.now() < until && (await driver.keyboardShown())) await sleep(150);
      await sleep(400);
      return true;
    },

    async tapSystemButton(label, options = {}) {
      await ensureAwake();
      const until = Date.now() + (options.timeoutMs ?? 6000);
      for (;;) {
        const nodes = parseUiNodes(await uiDump());
        const wanted = label.toLowerCase();
        const target = nodes.find(n => n.clickable && (n.text.toLowerCase() === wanted || n.desc.toLowerCase() === wanted));
        if (target) {
          await shell(`input tap ${target.x} ${target.y}`);
          await sleep(600);
          return true;
        }
        if (Date.now() > until) return false;
        await sleep(500);
      }
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

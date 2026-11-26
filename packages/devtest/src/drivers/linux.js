// The Linux desktop driver (`dk test linux-desktop`).
//
// - Page access: the debug-only evaluation channel of `droid-kit-platform` (a Unix
//   socket in `$XDG_RUNTIME_DIR/droid-kit/<identifier>/`, see that crate's
//   `evalchannel` module for the protocol). It runs JavaScript in the app's page.
// - Input: **inside the page**. A tap or swipe is pointer events (and click) dispatched
//   at the element, which is what React Aria's press handling listens to. It is not
//   pointer input from the system, so the results say so.
// - Screenshots: the app's own web view, through the same channel. Never the desktop.
// - Restart: the container is removed and `dk run linux-desktop --no-build` starts it
//   again. Reinstall is a full `dk run linux-desktop`.
// - Notifications: the `droid-kit-reminderd` journal for what was delivered, and the
//   service's `OpenReminder` method for a tap.

import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import net from 'node:net';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const sleep = (/** @type {number} */ ms) => new Promise(resolve => setTimeout(resolve, ms));

/** @typedef {import('../index.js').Driver} Driver */
/** @typedef {import('../index.js').TestContext} TestContext */
/** @typedef {import('../index.js').NotificationMatch} NotificationMatch */

// ---- what runs inside the page -------------------------------------------------------------

/**
 * Installed in the page once (`window.__dkTest`). Plain JavaScript: it is sent as text.
 * Every function throws a message that names the selector, so a failing step says what it could not find.
 */
function pageHelpers() {
  /** @param {string} selector */
  const find = selector => {
    const el = document.querySelector(selector);
    if (!el) throw new Error(`no element matches ${selector}`);
    return /** @type {HTMLElement} */ (el);
  };

  /** Scrolls the element into view the way a person would: the sheet's content, or the page's main area. Never `scrollIntoView` (it scrolls a sheet's swipe scroller). */
  /** @param {HTMLElement} el */
  const reveal = el => {
    const inView = () => {
      const r = el.getBoundingClientRect();
      return r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth;
    };
    if (inView()) return;
    const sheet = el.closest('.dk-sheet-content');
    const scroller = sheet ?? document.querySelector('[data-scroll-restoration-id="main"]');
    if (scroller) {
      const r = el.getBoundingClientRect();
      scroller.scrollBy({ top: r.top + r.height / 2 - innerHeight / 2, behavior: 'instant' });
    }
  };

  /** @param {HTMLElement} el */
  const centre = el => {
    reveal(el);
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) throw new Error(`the element ${el.tagName.toLowerCase()} has no size, so it cannot be tapped`);
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) throw new Error(`the element is not on the screen at (${Math.round(x)}, ${Math.round(y)})`);
    return { x, y };
  };

  /**
   * What a finger would hit at that point, and it must be the element or inside it (or the element
   * inside what is hit, such as a label around a checkbox): a covered element is an error, as it is on a phone.
   * @param {HTMLElement} el @param {number} x @param {number} y
   */
  const hit = (el, x, y) => {
    const top = document.elementFromPoint(x, y);
    if (!top) throw new Error('nothing at the middle of the element');
    if (!(el.contains(top) || top.contains(el))) {
      throw new Error(`the middle of the element is covered by ${top.tagName.toLowerCase()}${top.className ? `.${String(top.className).trim().split(/\s+/).join('.')}` : ''}`);
    }
    return top;
  };

  /** @param {Element} target @param {string} type @param {number} x @param {number} y @param {Record<string, unknown>} [extra] */
  const pointer = (target, type, x, y, extra = {}) =>
    target.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX: x,
        clientY: y,
        screenX: x,
        screenY: y,
        pointerId: 1,
        pointerType: 'touch',
        isPrimary: true,
        width: 1,
        height: 1,
        pressure: type === 'pointerup' || type === 'pointerover' ? 0 : 0.5,
        button: 0,
        buttons: type === 'pointerup' || type === 'pointerover' ? 0 : 1,
        ...extra,
      }),
    );

  /** @param {Element} target @param {string} type @param {number} x @param {number} y */
  const mouse = (target, type, x, y) =>
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, screenX: x, screenY: y, button: 0, buttons: type === 'mouseup' || type === 'click' ? 0 : 1, detail: 1, view: window }));

  const frame = () => new Promise(resolve => requestAnimationFrame(() => resolve(undefined)));

  return {
    /** A tap: the pointer sequence of a touch, then the click that follows it. */
    async tap(/** @type {string} */ selector) {
      const el = find(selector);
      const { x, y } = centre(el);
      const target = hit(el, x, y);
      pointer(target, 'pointerover', x, y);
      pointer(target, 'pointerenter', x, y);
      pointer(target, 'pointerdown', x, y);
      await frame();
      // Pointer events of a touch end the press; the page's handlers have run by the next frame.
      pointer(target, 'pointerup', x, y);
      pointer(target, 'pointerout', x, y);
      pointer(target, 'pointerleave', x, y);
      // The compatibility events a browser sends after a touch, ending with the click.
      mouse(target, 'mousedown', x, y);
      mouse(target, 'mouseup', x, y);
      mouse(target, 'click', x, y);
      await frame();
      return { x: Math.round(x), y: Math.round(y), hit: target.tagName.toLowerCase() };
    },

    /**
     * A swipe starting on the element: pointer events along the path, and then the scrolling that
     * a finger's drag does natively and a synthetic one does not, on the nearest scroller on that axis.
     */
    async swipe(/** @type {string} */ selector, /** @type {'up' | 'down' | 'left' | 'right'} */ direction) {
      const el = find(selector);
      const { x, y } = centre(el);
      const target = hit(el, x, y);
      const vertical = direction === 'up' || direction === 'down';
      const distance = Math.round((vertical ? innerHeight : innerWidth) * 0.6);
      const sign = direction === 'down' || direction === 'right' ? 1 : -1;
      pointer(target, 'pointerdown', x, y);
      const steps = 8;
      for (let i = 1; i <= steps; i++) {
        await frame();
        const d = (distance * i) / steps;
        pointer(target, 'pointermove', vertical ? x : x + sign * d, vertical ? y + sign * d : y);
      }
      // A finger moving down drags the content down: the scroller's position goes the other way.
      /** @type {Element | null} */
      let scroller = target;
      while (scroller) {
        const s = getComputedStyle(scroller);
        const scrolls = vertical ? /(auto|scroll)/.test(s.overflowY) && scroller.scrollHeight > scroller.clientHeight : /(auto|scroll)/.test(s.overflowX) && scroller.scrollWidth > scroller.clientWidth;
        if (scrolls) break;
        scroller = scroller.parentElement;
      }
      const end = vertical ? { x, y: y + sign * distance } : { x: x + sign * distance, y };
      if (scroller) {
        scroller.scrollBy(vertical ? { top: -sign * distance, behavior: 'instant' } : { left: -sign * distance, behavior: 'instant' });
        // A scroll that ends is announced; a synthetic one must say so itself for handlers that wait for it.
        await frame();
        scroller.dispatchEvent(new Event('scrollend', { bubbles: false }));
      }
      pointer(target, 'pointerup', end.x, end.y);
      await frame();
      return { scrolled: Boolean(scroller) };
    },

    /** Focus the field and put the text at the end of its value, through the native setter, then an `input` event (which React listens to). */
    async type(/** @type {string} */ selector, /** @type {string} */ text) {
      const el = find(selector);
      if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) throw new Error(`${selector} is not a text field`);
      el.focus();
      if (document.activeElement !== el) throw new Error(`${selector} did not take the focus`);
      const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      const set = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (!set) throw new Error('no native value setter');
      set.call(el, el.value + text);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text }));
      await frame();
      return el.value;
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

    /** What the system's back would do on Android, with the means a desktop has. */
    async back() {
      const overlay = document.querySelector('[role="listbox"], [role="dialog"], [role="alertdialog"]');
      const popup = overlay?.closest('[data-trigger], [role="dialog"], .react-aria-Popover') ?? null;
      const index = /** @type {{ __TSR_index?: number } | null} */ (history.state)?.__TSR_index;
      if (popup && !document.querySelector('.dk-sheet-overlay')) {
        document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
        await frame();
        return 'escape (an overlay was open)';
      }
      if (typeof index === 'number' && index > 0) {
        history.back();
        await new Promise(resolve => setTimeout(resolve, 120));
        return 'history.back()';
      }
      const button = document.querySelector('[aria-label="Back"]');
      if (button instanceof HTMLElement) {
        const r = button.getBoundingClientRect();
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        const target = hit(button, x, y);
        pointer(target, 'pointerdown', x, y);
        await frame();
        pointer(target, 'pointerup', x, y);
        mouse(target, 'click', x, y);
        await frame();
        return "the app bar's back button";
      }
      history.back();
      await new Promise(resolve => setTimeout(resolve, 120));
      return 'history.back()';
    },
  };
}

/** The expression that calls a helper, installing the helpers first if the page is new. */
const helper = (/** @type {string} */ name, /** @type {unknown[]} */ args) => `(window.__dkTest ??= (${pageHelpers.toString()})()).${name}(...${JSON.stringify(args)})`;

// ---- the channel ---------------------------------------------------------------------------

/** One connection to the app's evaluation channel, reopened when the app restarts. */
class Channel {
  /** @param {string} path */
  constructor(path) {
    this.path = path;
    /** @type {net.Socket | null} */
    this.socket = null;
    this.next = 0;
    /** @type {Map<number, { resolve: (v: any) => void, reject: (e: Error) => void }>} */
    this.pending = new Map();
    this.buffer = '';
  }

  /** @param {number} waitMs */
  async connect(waitMs) {
    const until = Date.now() + waitMs;
    for (;;) {
      try {
        await this.#open();
        await this.request({ op: 'ping' }, 5000);
        return;
      } catch (e) {
        this.drop();
        if (Date.now() > until) throw new Error(`the app's evaluation channel (${this.path}) did not come up: ${e instanceof Error ? e.message : e}`);
        await sleep(300);
      }
    }
  }

  #open() {
    return new Promise((resolve, reject) => {
      const s = net.connect(this.path);
      s.once('error', reject);
      s.once('connect', () => {
        s.off('error', reject);
        this.socket = s;
        this.buffer = '';
        s.on('data', d => this.#data(String(d)));
        s.on('close', () => this.#closed());
        s.on('error', () => {});
        resolve(undefined);
      });
    });
  }

  /** @param {string} chunk */
  #data(chunk) {
    this.buffer += chunk;
    for (let i = this.buffer.indexOf('\n'); i >= 0; i = this.buffer.indexOf('\n')) {
      const line = this.buffer.slice(0, i);
      this.buffer = this.buffer.slice(i + 1);
      const reply = JSON.parse(line);
      const waiter = this.pending.get(reply.id);
      if (!waiter) continue;
      this.pending.delete(reply.id);
      if (reply.ok) waiter.resolve(reply.value ?? null);
      else waiter.reject(new Error(reply.error));
    }
  }

  #closed() {
    this.socket = null;
    for (const w of this.pending.values()) w.reject(new Error('the app closed the evaluation channel (it stopped)'));
    this.pending.clear();
  }

  drop() {
    this.socket?.destroy();
    this.socket = null;
  }

  /** @param {Record<string, unknown>} body @param {number} timeoutMs */
  request(body, timeoutMs) {
    const socket = this.socket;
    if (!socket) return Promise.reject(new Error('not connected to the app'));
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`no answer from the app within ${timeoutMs} ms`));
      }, timeoutMs + 2000);
      this.pending.set(id, {
        resolve: v => (clearTimeout(timer), resolve(v)),
        reject: e => (clearTimeout(timer), reject(e)),
      });
      socket.write(`${JSON.stringify({ id, timeoutMs, ...body })}\n`);
    });
  }
}

// ---- the driver ----------------------------------------------------------------------------

/** The characters of an application id that a D-Bus object path keeps. */
const pathElement = (/** @type {string} */ s) => s.replace(/[^A-Za-z0-9]/g, '_');

/** @type {import('../index.js').CreateDriver} */
export async function createDriver(context) {
  const runtime = process.env.XDG_RUNTIME_DIR;
  if (!runtime) throw new Error('XDG_RUNTIME_DIR is not set: dk test linux-desktop needs the desktop session');
  const socketPath = join(runtime, 'droid-kit', context.identifier, 'eval.sock');
  const container = `dk-${basename(context.appDir)}`;
  const unit = `${context.identifier}-reminders.service`;
  const startedAt = Math.floor(Date.now() / 1000) - 2;
  const channel = new Channel(socketPath);
  mkdirSync(context.runDir, { recursive: true });

  /** @param {string} expression @param {number} [timeoutMs] */
  const evaluate = async (expression, timeoutMs = 30_000) => {
    if (!channel.socket) await channel.connect(5000);
    return channel.request({ op: 'eval', expression }, timeoutMs);
  };

  /** Runs `dk` in the app's directory and rejects with the tail of its output if it fails. @param {string[]} args */
  const dk = args =>
    new Promise((resolve, reject) => {
      const child = spawn(context.dk, args, { cwd: context.appDir, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', d => (output += d));
      child.stderr.on('data', d => (output += d));
      child.on('error', reject);
      child.on('close', code => (code === 0 ? resolve(output) : reject(new Error(`dk ${args.join(' ')} exited ${code}: ${output.trim().split('\n').slice(-6).join(' | ')}`))));
    });

  const stopContainer = async () => {
    channel.drop();
    await run('podman', ['rm', '-f', '-t', '0', container]).catch(() => {});
  };

  /** The reminders the app has scheduled, from the file the plugin writes. */
  const scheduled = () => {
    const dataHome = process.env.XDG_DATA_HOME || join(process.env.HOME ?? '', '.local/share');
    try {
      return /** @type {{ id: string, title: string }[]} */ (JSON.parse(readFileSync(join(dataHome, context.identifier, 'reminders.json'), 'utf8')));
    } catch {
      return [];
    }
  };
  /** @type {Map<string, string>} */
  const titles = new Map();
  /** The reminder id a match means: the id itself, or the id of the reminder with that title. @param {NotificationMatch} match */
  const reminderId = match => {
    for (const r of scheduled()) titles.set(r.title, r.id);
    const id = match.id ?? (match.title !== undefined ? titles.get(match.title) : undefined);
    return id;
  };

  const delivered = async () => {
    const { stdout } = await run('journalctl', ['--user', '-u', unit, '-o', 'cat', '--no-pager', '--since', `@${startedAt}`]).catch(() => ({ stdout: '' }));
    return [...stdout.matchAll(/delivered (\S+) \(due [^)]*\) as notification (\d+)/g)].map(m => m[1]);
  };

  /** @type {Driver} */
  const driver = {
    target: context.target,
    capabilities: new Set(['notifications', 'reinstall']),
    inputLabel: 'inside the page (DOM events), not pointer input',

    async open(route) {
      await evaluate(helper('open', [route]));
    },
    async tap(selector) {
      await evaluate(helper('tap', [selector]));
    },
    async swipe(selector, direction) {
      await evaluate(helper('swipe', [selector, direction]));
    },
    async type(selector, text) {
      await evaluate(helper('type', [selector, text]));
    },
    async back() {
      await evaluate(helper('back', []));
    },
    eval: /** @type {Driver['eval']} */ (expression => /** @type {any} */ (evaluate(expression))),
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
        await sleep(100);
      }
    },
    async screenshot(name) {
      const path = join(context.runDir, `${name}.png`);
      if (!channel.socket) await channel.connect(5000);
      await channel.request({ op: 'screenshot', path }, 15_000);
      return path;
    },
    async forceStop() {
      await stopContainer();
    },
    async restart() {
      await stopContainer();
      await dk(['run', 'linux-desktop', '--no-build']);
      await channel.connect(30_000);
    },
    async reinstall() {
      await stopContainer();
      await dk(['run', 'linux-desktop']);
      await channel.connect(30_000);
    },
    async waitForNotification(match, options = {}) {
      const until = Date.now() + (options.timeoutMs ?? 10_000);
      for (;;) {
        const id = reminderId(match);
        if (id !== undefined && (await delivered()).includes(id)) return;
        if (Date.now() > until) {
          throw new Error(`no notification for ${JSON.stringify(match)} in the journal of ${unit}${id === undefined ? ' (the title is not in the app\'s reminders.json)' : ''}`);
        }
        await sleep(500);
      }
    },
    async tapNotification(match) {
      const id = reminderId(match);
      if (id === undefined) throw new Error(`cannot tell which reminder ${JSON.stringify(match)} is: it is not in the app's reminders.json`);
      await run('busctl', ['--user', 'call', `${context.identifier}.Reminders`, `/dev/droidkit/Reminders/${pathElement(context.identifier)}`, 'dev.droidkit.Reminders1', 'OpenReminder', 's', id]);
      // The service asked the running app, or started it (a new container): wait for the channel and the page.
      await sleep(500);
      await channel.connect(40_000);
      await driver.waitFor(`document.readyState === 'complete' && document.querySelector('#root')?.children.length > 0`, { timeoutMs: 30_000 });
    },
    async close() {
      channel.drop();
    },
  };

  if (!existsSync(join(runtime, 'droid-kit', context.identifier))) {
    throw new Error(`${join(runtime, 'droid-kit', context.identifier)} does not exist: start the app with \`dk run linux-desktop\` (a debug build) first`);
  }
  await channel.connect(30_000);
  return driver;
}

// The iPhone driver (`dk test ios-phone`).
//
// - Page access: `pymobiledevice3 webinspector cdp`, a DevTools-protocol bridge to the app's
//   WKWebView (the iPhone on USB, Settings > Safari > Advanced > Web Inspector on, Developer
//   Mode on). Its Runtime.evaluate does not wait for a promise, so every evaluation stores its
//   result in a `window` variable that a second call reads.
// - Input: **inside the page**, the same pointer, mouse and click events the Linux driver
//   dispatches (its page helpers are used as they are). iOS has no way to inject touches without
//   Xcode, and Web Inspector offers none. The results say it was not real touch.
// - The app must be in front: Web Inspector cannot reach a suspended app, and every call then
//   times out. The app is started with `dvt launch` and brought back to the front before a
//   scenario when it does not answer. A locked or sleeping iPhone cannot be helped from here.
// - Screenshots: the phone's screen (`dvt screenshot`) while the app is in front.
// - Restart: `dvt kill` and `dvt launch --kill-existing`. Reinstall is a full `dk run ios-phone`
//   (which stops the app first, because an install hangs at "[Connecting] 100%" while an app
//   that was started through the developer services runs).
// - Notifications: none. Tapping a banner needs a finger, and the system's list of delivered
//   notifications cannot be read from the page (the notification plugin's `get_active` crashes the
//   app on notifications it did not create). So `notifications` is not a capability here, and a
//   scenario that needs it is skipped and reported. `pending()` (not part of Driver) reads the
//   pending requests through the plugin.

import { execFile, spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { helper } from './linux.js';

const execFileAsync = promisify(execFile);
const sleep = (/** @type {number} */ ms) => new Promise(resolve => setTimeout(resolve, ms));

/** @typedef {import('../index.js').Driver} Driver */

/** The pymobiledevice3 executable (DK_PYMOBILEDEVICE3 names another, for the driver's own tests). */
const pmdPath = () => process.env.DK_PYMOBILEDEVICE3 || 'pymobiledevice3';

/** Runs pymobiledevice3 and returns its output; rejects with its last lines. @param {string[]} args @param {number} [timeoutMs] */
async function pmd(args, timeoutMs = 60_000) {
  try {
    const { stdout } = await execFileAsync(pmdPath(), args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  } catch (e) {
    const err = /** @type {{ stderr?: string, message: string }} */ (e);
    throw new Error(`pymobiledevice3 ${args.join(' ')}: ${(err.stderr || err.message).trim().split('\n').slice(-3).join(' | ')}`);
  }
}

/** A free TCP port on the loopback address. */
const freePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = /** @type {net.AddressInfo} */ (server.address());
      server.close(() => resolve(port));
    });
  });

/** The Web Inspector bridge process, and one WebSocket to the app's page through it. */
class Page {
  /** @param {number} port @param {() => Promise<string | null>} pidOf the running app's process id: other apps' pages are listed too */
  constructor(port, pidOf) {
    this.port = port;
    this.pidOf = pidOf;
    /** @type {import('node:child_process').ChildProcess | null} */
    this.bridge = null;
    /** @type {WebSocket | null} */
    this.ws = null;
    this.next = 0;
    /** @type {Map<number, { resolve: (v: any) => void, reject: (e: Error) => void }>} */
    this.pending = new Map();
    this.log = '';
  }

  startBridge() {
    if (this.bridge && this.bridge.exitCode === null) return;
    this.bridge = spawn(pmdPath(), ['webinspector', 'cdp', '--host', '127.0.0.1', '--port', String(this.port)], { stdio: ['ignore', 'pipe', 'pipe'] });
    this.log = '';
    for (const stream of [this.bridge.stdout, this.bridge.stderr]) stream?.on('data', d => (this.log = (this.log + d).slice(-4000)));
  }

  /** The running app's page in the bridge's list (an app's WKWebView shows `tauri://localhost`; its id is `PID:<pid>:<n>`), or undefined. */
  async target() {
    try {
      const pid = await this.pidOf().catch(() => null);
      const list = /** @type {{ id: string, type: string, url: string, webSocketDebuggerUrl: string }[]} */ (await fetch(`http://127.0.0.1:${this.port}/json`, { signal: AbortSignal.timeout(3000) }).then(r => r.json()));
      return list.find(t => t.type === 'page' && t.url.startsWith('tauri://') && (pid === null || t.id.startsWith(`PID:${pid}:`)));
    } catch {
      return undefined;
    }
  }

  /** Connects to the page, waiting for the app's page to be listed. @param {number} waitMs */
  async connect(waitMs) {
    this.dropSocket();
    this.startBridge();
    const until = Date.now() + waitMs;
    for (;;) {
      if (this.bridge && this.bridge.exitCode !== null) {
        this.bridge = null;
        this.startBridge();
      }
      const target = await this.target();
      if (target) {
        try {
          await this.#open(target.webSocketDebuggerUrl);
          await this.request('Runtime.evaluate', { expression: '1', returnByValue: true }, 5000);
          return;
        } catch {
          this.dropSocket();
        }
      }
      if (Date.now() > until) {
        throw new Error(`the app's page did not answer through Web Inspector within ${Math.round(waitMs / 1000)} s: is the iPhone unlocked with the app in front, and Web Inspector on (Settings > Apps > Safari > Advanced)? ${this.log.trim().split('\n').slice(-2).join(' | ')}`);
      }
      await sleep(500);
    }
  }

  /** @param {string} url */
  #open(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener('error', () => reject(new Error('could not open the page socket')), { once: true });
      ws.addEventListener('open', () => {
        this.ws = ws;
        resolve(undefined);
      }, { once: true });
      ws.addEventListener('message', e => {
        const m = JSON.parse(String(e.data));
        const waiter = this.pending.get(m.id);
        if (!waiter) return;
        this.pending.delete(m.id);
        if (m.error) waiter.reject(new Error(m.error.message ?? JSON.stringify(m.error)));
        else waiter.resolve(m.result);
      });
      ws.addEventListener('close', () => {
        if (this.ws === ws) this.ws = null;
        for (const w of this.pending.values()) w.reject(new Error('the page closed the connection (the app stopped or went to the background)'));
        this.pending.clear();
      });
    });
  }

  /** @param {string} method @param {Record<string, unknown>} params @param {number} timeoutMs */
  request(method, params, timeoutMs) {
    const ws = this.ws;
    if (!ws) return Promise.reject(new Error('not connected to the page'));
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`no reply from the page within ${timeoutMs} ms (is the app in front, and the iPhone unlocked? Web Inspector cannot reach a suspended app)`));
      }, timeoutMs);
      this.pending.set(id, { resolve: v => (clearTimeout(timer), resolve(v)), reject: e => (clearTimeout(timer), reject(e)) });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  dropSocket() {
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close();
    } catch {}
  }

  close() {
    this.dropSocket();
    this.bridge?.kill('SIGTERM');
    this.bridge = null;
  }
}

/**
 * On the iPhone `scrollBy({ top, behavior: 'instant' })` scrolls twice: the new position shows at once, and a frame
 * later the same distance is added again (300 asked for, 600 reached; assigning `scrollTop` is exact). The Linux
 * helpers scroll with it, and a second scroll puts the element under the app bar or off the screen. So an
 * "instant" scroll is an assignment here, installed once in the page before a helper runs.
 */
const SCROLL_SHIM = `(() => {
  if (Element.prototype.__dkScrollBy) return;
  const original = Element.prototype.scrollBy;
  Element.prototype.__dkScrollBy = true;
  Element.prototype.scrollBy = function (options) {
    if (options && typeof options === 'object' && options.behavior === 'instant') {
      this.scrollTop += options.top || 0;
      this.scrollLeft += options.left || 0;
      return;
    }
    return original.apply(this, arguments);
  };
})()`;

/** A page helper call, with the scroll fix installed first. @param {string} name @param {unknown[]} args */
const pageHelper = (name, args) => `(${SCROLL_SHIM}, ${helper(name, args)})`;

/** @type {import('../index.js').CreateDriver} */
export async function createDriver(context) {
  mkdirSync(context.runDir, { recursive: true });
  const identifier = context.identifier;

  /** The installed bundle id: xtool signs with a free Apple ID as `XTL-<team>.<identifier>`. */
  const bundle = async () => {
    const apps = JSON.parse(await pmd(['apps', 'list', '-t', 'User']));
    const id = Object.keys(apps).find(k => k === identifier || k.endsWith(`.${identifier}`));
    if (!id) throw new Error(`${identifier} is not installed on the iPhone: run \`dk run ios-phone\` first`);
    return id;
  };

  /** @type {Page} */
  let page;
  let evaluations = 0;
  /** How long one evaluation may take (DK_IOS_EVAL_TIMEOUT_MS, for the driver's own tests). */
  const EVAL_TIMEOUT_MS = Number(process.env.DK_IOS_EVAL_TIMEOUT_MS) || 30_000;

  /** The process id of the running app, or null. */
  const pid = async () => {
    const out = (await pmd(['developer', 'dvt', 'process-id-for-bundle-id', await bundle()])).trim().split('\n').pop() ?? '';
    return /^\d+$/.test(out) && out !== '0' ? out : null;
  };
  page = new Page(Number(process.env.DK_IOS_CDP_PORT) || /** @type {number} */ (await freePort()), pid);
  const stop = async () => {
    page.dropSocket();
    const p = await pid();
    if (p) await pmd(['developer', 'dvt', 'kill', p]);
  };
  /** @param {boolean} killExisting */
  const launch = async killExisting => {
    // The first launch after an install can fail while the phone registers the app.
    for (let attempt = 1; ; attempt++) {
      try {
        await pmd(['developer', 'dvt', 'launch', ...(killExisting ? ['--kill-existing'] : ['--no-kill-existing']), await bundle()]);
        return;
      } catch (e) {
        if (attempt >= 4) throw e;
        await sleep(3000);
      }
    }
  };
  /** Waits for the page to be up and drawn. */
  const ready = async (/** @type {number} */ waitMs) => {
    await page.connect(waitMs);
    const until = Date.now() + waitMs;
    for (;;) {
      if ((await evaluate(`document.readyState === 'complete' && document.querySelector('#root')?.children.length > 0`, 5000).catch(() => false)) === true) return;
      if (Date.now() > until) throw new Error('the app started but its first screen did not render');
      await sleep(300);
    }
  };

  /**
   * Evaluates in the page. Web Inspector's Runtime.evaluate does not wait for a promise, so the expression runs
   * (as a script, through indirect eval, so statements work too) inside an async function that stores its outcome
   * in `window.__dkTestResults[id]`, and a second call reads it.
   * @param {string} expression @param {number} [timeoutMs]
   */
  async function evaluate(expression, timeoutMs = EVAL_TIMEOUT_MS) {
    if (!page.ws) await page.connect(10_000);
    const id = `${Date.now()}-${++evaluations}`;
    const start = `(() => { const r = (window.__dkTestResults ??= {}); r[${JSON.stringify(id)}] = null; (async () => { try { const v = await (0, eval)(${JSON.stringify(expression)}); r[${JSON.stringify(id)}] = JSON.stringify({ ok: v === undefined ? null : v }); } catch (e) { r[${JSON.stringify(id)}] = JSON.stringify({ err: String((e && e.message) || e) }); } })(); return true; })()`;
    const started = await page.request('Runtime.evaluate', { expression: start, returnByValue: true }, Math.min(timeoutMs, 15_000));
    if (started.exceptionDetails) throw new Error(`the page could not run the expression: ${JSON.stringify(started.exceptionDetails.text ?? started.exceptionDetails)}`);
    const until = Date.now() + timeoutMs;
    for (;;) {
      const read = await page.request('Runtime.evaluate', { expression: `(() => { const r = window.__dkTestResults; const v = r && r[${JSON.stringify(id)}]; if (v) delete r[${JSON.stringify(id)}]; return v || null; })()`, returnByValue: true }, 15_000);
      const value = read.result?.value;
      if (typeof value === 'string') {
        const outcome = JSON.parse(value);
        if ('err' in outcome) throw new Error(outcome.err);
        return outcome.ok;
      }
      if (Date.now() > until) throw new Error(`the expression did not finish within ${timeoutMs} ms: ${expression.slice(0, 120)}`);
      await sleep(40);
    }
  }

  /**
   * Runs a page helper that needs the element where a finger would find it. WebKit on the iPhone starts a sheet's
   * slide-in and the router's scroll restoration a moment later than the other targets do, so for a little while an
   * element can still be below the screen or under the app bar. A person waits for it to arrive; so does this, for
   * up to 3 s, and only for those two reasons. Any other error, or the same one after that, fails the step.
   * @param {string} name @param {unknown[]} args
   */
  const placed = async (name, args) => {
    const until = Date.now() + 3000;
    for (;;) {
      try {
        return await evaluate(pageHelper(name, args));
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (!/is not on the screen|is covered by/.test(message) || Date.now() > until) throw e;
        await sleep(250);
      }
    }
  };

  /** `dk` in the app's directory; rejects with the tail of its output. @param {string[]} args */
  const dk = args =>
    new Promise((resolve, reject) => {
      const child = spawn(context.dk, args, { cwd: context.appDir, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', d => (output += d));
      child.stderr.on('data', d => (output += d));
      child.on('error', reject);
      child.on('close', code => (code === 0 ? resolve(output) : reject(new Error(`dk ${args.join(' ')} exited ${code}: ${output.trim().split('\n').slice(-6).join(' | ')}`))));
    });

  /** @param {string} what */
  const needsFinger = what => new Error(`${what} needs a finger: the iPhone driver has no 'notifications' capability (Web Inspector cannot tap system banners)`);

  /** @type {Driver & { pending(): Promise<{ title: string, body: string }[]> }} */
  const driver = {
    target: context.target,
    capabilities: new Set(['reinstall']),
    inputLabel: 'inside the page (Web Inspector: DOM pointer events), not real touch',

    async beforeScenario() {
      // Web Inspector cannot reach an app that went to the background: bring it back, or start it again.
      if ((await evaluate('1', 6000).catch(() => undefined)) === 1) return;
      await launch(false);
      if ((await page.connect(15_000).then(() => evaluate('1', 6000)).catch(() => undefined)) === 1) return;
      await stop();
      await launch(true);
      await ready(40_000);
    },
    async open(route) {
      await evaluate(pageHelper('open', [route]));
    },
    async tap(selector) {
      await placed('tap', [selector]);
    },
    async swipe(selector, direction) {
      await placed('swipe', [selector, direction]);
    },
    async type(selector, text) {
      await evaluate(pageHelper('type', [selector, text]));
    },
    async back() {
      await evaluate(pageHelper('back', []));
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
      await pmd(['developer', 'dvt', 'screenshot', path], 60_000);
      return path;
    },
    async forceStop() {
      await stop();
    },
    async restart() {
      await stop();
      await launch(true);
      await ready(40_000);
    },
    async reinstall() {
      await stop();
      await dk(['run', 'ios-phone']);
      page.dropSocket();
      await ready(40_000);
    },
    async waitForNotification() {
      throw needsFinger('waiting for a banner');
    },
    async tapNotification() {
      throw needsFinger('tapping a banner');
    },
    /** The requests the system has pending, through the notification plugin (titles and bodies only: it returns no dates). */
    async pending() {
      return evaluate(`window.__TAURI_INTERNALS__.invoke('plugin:notification|get_pending')`);
    },
    async close() {
      page.close();
    },
  };

  // The app must already run (`dk test` started it): connect to its page.
  await bundle();
  // With --no-build the app may be in the background, or not running: bring it to the front (start it if it is not running).
  try {
    await ready(Number(process.env.DK_IOS_FIRST_WAIT_MS) || 8_000);
  } catch {
    await launch(false);
    await ready(40_000);
  }
  return driver;
}

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { createHash } from 'node:crypto';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TestContext } from '../src/index.js';
import { createDriver } from '../src/drivers/ios.js';

// A stand-in for `pymobiledevice3` and for the app's page behind Web Inspector's DevTools bridge. The page is a
// `vm` context that really runs what the driver sends, and whose Runtime.evaluate, like WebKit's bridge, does not
// wait for a promise: a driver that relied on that would fail here.

let dir: string;
let server: http.Server;
let sockets: Socket[];
let page: vm.Context;
let evaluations: string[];
let notified: string[];
const saved = { pmd: process.env.DK_PYMOBILEDEVICE3, port: process.env.DK_IOS_CDP_PORT, timeout: process.env.DK_IOS_EVAL_TIMEOUT_MS };

/** A text frame, server to client (unmasked). */
const frame = (text: string) => {
  const payload = Buffer.from(text);
  const head = payload.length < 126 ? Buffer.from([0x81, payload.length]) : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 255]);
  return Buffer.concat([head, payload]);
};

/** The text of every complete client frame in `buffer` (masked, as a client sends them). */
const frames = (buffer: Buffer<ArrayBufferLike>): { texts: string[]; rest: Buffer } => {
  const texts: string[] = [];
  let at = 0;
  for (;;) {
    if (buffer.length - at < 2) break;
    const opcode = buffer[at] & 15;
    let length = buffer[at + 1] & 127;
    let offset = at + 2;
    if (length === 126) {
      if (buffer.length < offset + 2) break;
      length = buffer.readUInt16BE(offset);
      offset += 2;
    }
    if (buffer.length < offset + 4 + length) break;
    const mask = buffer.subarray(offset, offset + 4);
    const data = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
    for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
    if (opcode === 1) texts.push(data.toString());
    at = offset + 4 + length;
  }
  return { texts, rest: buffer.subarray(at) };
};

let port: number;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dk-devtest-ios-'));
  evaluations = [];
  notified = [];
  sockets = [];
  page = vm.createContext({ setTimeout, Promise, JSON, String, console });
  page.window = page;
  // The page is the context's global. `document` is just enough for the driver's own readiness check.
  page.document = { readyState: 'complete', querySelector: () => ({ children: [1] }) };

  server = http.createServer((req, res) => {
    if (req.url === '/json') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify([{ id: 'PID:9999:1', type: 'page', url: 'tauri://localhost', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/0` }, { id: 'PID:4242:1', type: 'page', url: 'tauri://localhost', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/1` }]));
    } else res.statusCode = 404, res.end();
  });
  server.on('upgrade', (req, socket: Socket) => {
    // The page of another app (a process that is not the one the phone reports) must not be used.
    if (req.url?.endsWith('/0')) return void socket.destroy();
    sockets.push(socket);
    const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      const got = frames(Buffer.concat([buffer, chunk]));
      buffer = got.rest;
      for (const text of got.texts) {
        const message = JSON.parse(text) as { id: number; method: string; params: { expression: string } };
        evaluations.push(message.params.expression);
        let result: unknown;
        try {
          // WebKit's bridge returns at once with the completion value: a promise is just an object.
          const value = vm.runInContext(message.params.expression, page);
          result = { result: { type: 'object', value: value instanceof Promise ? {} : value } };
        } catch (e) {
          result = { exceptionDetails: { text: String(e) } };
        }
        socket.write(frame(JSON.stringify({ id: message.id, result })));
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;

  // `pymobiledevice3`: the app is installed as XTL-ABC.com.example.app; kill and launch are recorded.
  const fake = join(dir, 'pymobiledevice3');
  writeFileSync(
    fake,
    `#!/bin/sh
case "$*" in
  "apps list -t User") echo '{"XTL-ABC.com.example.app": {}}' ;;
  "developer dvt process-id-for-bundle-id "*) echo 4242 ;;
  "webinspector cdp"*) exec sleep 30 ;;
  *) echo "$*" >> "${join(dir, 'calls')}" ;;
esac
`,
  );
  chmodSync(fake, 0o755);
  process.env.DK_PYMOBILEDEVICE3 = fake;
  process.env.DK_IOS_CDP_PORT = String(port);
});

afterEach(async () => {
  for (const s of sockets) s.destroy();
  await new Promise(resolve => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
  for (const [key, value] of [['DK_PYMOBILEDEVICE3', saved.pmd], ['DK_IOS_CDP_PORT', saved.port], ['DK_IOS_EVAL_TIMEOUT_MS', saved.timeout]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const context = (): TestContext => ({
  target: 'ios-phone',
  appDir: join(dir, 'apps', 'demo'),
  identifier: 'com.example.app',
  androidPackage: 'com.example.app',
  binary: 'demo',
  artifacts: join(dir, 'artifacts'),
  runDir: join(dir, 'artifacts', 'devtest', 'run'),
  dk: '/nonexistent/dk',
  android: { adb: '', host: '', hostRoot: '' },
  linux: { image: 'x' },
});

describe('the iPhone driver', () => {
  it('says what it is: input inside the page, not real touch; reinstall, but no notifications', async () => {
    const d = await createDriver(context());
    expect(d.target).toBe('ios-phone');
    expect(d.inputLabel).toMatch(/inside the page/);
    expect(d.inputLabel).toMatch(/not real touch/);
    expect(d.capabilities.has('realInput')).toBe(false);
    expect(d.capabilities.has('notifications')).toBe(false);
    expect(d.capabilities.has('clock')).toBe(false);
    expect(d.capabilities.has('reinstall')).toBe(true);
    await d.close();
  });

  it('evaluates values, and waits for a promise the bridge does not wait for', async () => {
    const d = await createDriver(context());
    expect(await d.eval('1 + 2')).toBe(3);
    expect(await d.eval('({ a: [1, "x"], b: null })')).toEqual({ a: [1, 'x'], b: null });
    expect(await d.eval('new Promise(resolve => setTimeout(() => resolve("later"), 120))')).toBe('later');
    expect(await d.eval('undefined')).toBe(null);
    // A script with statements works too.
    expect(await d.eval('const a = 2; a * 21')).toBe(42);
    await d.close();
  });

  it('turns a thrown error or a rejected promise into a failed step with its message', async () => {
    const d = await createDriver(context());
    await expect(d.eval('missing.thing')).rejects.toThrow(/missing is not defined/);
    await expect(d.eval('Promise.reject(new Error("nope"))')).rejects.toThrow('nope');
    await d.close();
  });

  it('waitFor polls until the expression is truthy, and says what it waited for when it is not', async () => {
    const d = await createDriver(context());
    await d.eval('window.n = 0');
    await d.eval('(setTimeout(() => { window.n = 5; }, 250), 0)');
    await d.waitFor('window.n === 5', { timeoutMs: 3000 });
    await expect(d.waitFor('window.n === 99', { timeoutMs: 300 })).rejects.toThrow(/timed out waiting for window\.n === 99/);
    await d.close();
  });

  it('refuses notifications by saying a finger is needed', async () => {
    const d = await createDriver(context());
    await expect(d.waitForNotification({ title: 'x' })).rejects.toThrow(/needs a finger/);
    await expect(d.tapNotification({ title: 'x' })).rejects.toThrow(/needs a finger/);
    await d.close();
  });

  it('stops the app with the process id the phone gives, and starts it with the installed bundle id', async () => {
    const d = await createDriver(context());
    await d.forceStop();
    await d.restart();
    const { readFileSync } = await import('node:fs');
    const calls = readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n');
    expect(calls[0]).toBe('developer dvt kill 4242');
    expect(calls).toContain('developer dvt launch --kill-existing XTL-ABC.com.example.app');
    await d.close();
  });

  it('fails clearly when the app is not installed', async () => {
    writeFileSync(process.env.DK_PYMOBILEDEVICE3!, '#!/bin/sh\ncase "$*" in "apps list -t User") echo "{}" ;; "webinspector cdp"*) exec sleep 30 ;; esac\n');
    await expect(createDriver(context())).rejects.toThrow(/not installed on the iPhone/);
  });

  it('says what to check when the page never answers', async () => {
    process.env.DK_IOS_EVAL_TIMEOUT_MS = '400';
    const d = await createDriver(context());
    // A page that is suspended answers nothing.
    for (const s of sockets) s.removeAllListeners('data');
    await expect(d.eval('1')).rejects.toThrow(/no reply from the page|did not finish/);
    await d.close();
  });
});

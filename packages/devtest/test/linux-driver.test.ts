import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TestContext } from '../src/index.js';
import { createDriver } from '../src/drivers/linux.js';

// A stand-in for the app's evaluation channel (see `evalchannel.rs` in droid-kit-platform for the protocol).
type Request = { id: number; op: string; expression?: string; path?: string; timeoutMs?: number };

let dir: string;
let server: net.Server;
let requests: Request[];
let answer: (r: Request) => { ok: true; value: unknown } | { ok: false; error: string };
const saved = process.env.XDG_RUNTIME_DIR;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dk-devtest-'));
  process.env.XDG_RUNTIME_DIR = dir;
  mkdirSync(join(dir, 'droid-kit', 'com.example.app'), { recursive: true });
  requests = [];
  answer = r => (r.op === 'ping' ? { ok: true, value: { identifier: 'com.example.app' } } : { ok: true, value: null });
  server = net.createServer(socket => {
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk;
      for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
        const request = JSON.parse(buffer.slice(0, i)) as Request;
        buffer = buffer.slice(i + 1);
        requests.push(request);
        socket.write(`${JSON.stringify({ id: request.id, ...answer(request) })}\n`);
      }
    });
  });
  await new Promise<void>(resolve => server.listen(join(dir, 'droid-kit', 'com.example.app', 'eval.sock'), resolve));
});

afterEach(async () => {
  await new Promise(resolve => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
  if (saved === undefined) delete process.env.XDG_RUNTIME_DIR;
  else process.env.XDG_RUNTIME_DIR = saved;
});

const context = (): TestContext => ({
  target: 'linux-desktop',
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

describe('the Linux driver', () => {
  it('says what it is: input inside the page, with notifications and reinstall, and no real input', async () => {
    const d = await createDriver(context());
    expect(d.target).toBe('linux-desktop');
    expect(d.inputLabel).toBe('inside the page (DOM events), not pointer input');
    expect([...d.capabilities].sort()).toEqual(['notifications', 'reinstall']);
    expect(d.capabilities.has('realInput')).toBe(false);
    expect(d.capabilities.has('clock')).toBe(false);
    expect(requests[0]).toMatchObject({ op: 'ping' });
    await d.close();
  });

  it('eval sends the expression and returns the JSON the page answered', async () => {
    answer = r => (r.op === 'eval' ? { ok: true, value: { n: 2 } } : { ok: true, value: null });
    const d = await createDriver(context());
    expect(await d.eval('({ n: 1 + 1 })')).toEqual({ n: 2 });
    expect(requests.at(-1)).toMatchObject({ op: 'eval', expression: '({ n: 1 + 1 })' });
    await d.close();
  });

  it('a page error rejects with the page\'s message', async () => {
    answer = r => (r.op === 'eval' ? { ok: false, error: 'ReferenceError: Can\'t find variable: nope' } : { ok: true, value: null });
    const d = await createDriver(context());
    await expect(d.eval('nope')).rejects.toThrow("Can't find variable: nope");
    await d.close();
  });

  it('tap, swipe, type, back and open call the page helpers with their arguments', async () => {
    const d = await createDriver(context());
    await d.tap('button[aria-label="New habit"]');
    await d.swipe('.dk-sheet-handle', 'down');
    await d.type('#name', 'Evening walk');
    await d.back();
    await d.open('/week?sheet=new-habit');
    const sent = requests.filter(r => r.op === 'eval').map(r => r.expression ?? '');
    expect(sent).toHaveLength(5);
    for (const s of sent) expect(s).toContain('window.__dkTest ??=');
    expect(sent[0]).toContain('.tap(...["button[aria-label=\\"New habit\\"]"])');
    expect(sent[1]).toContain('.swipe(...[".dk-sheet-handle","down"])');
    expect(sent[2]).toContain('.type(...["#name","Evening walk"])');
    expect(sent[3]).toContain('.back(...[])');
    expect(sent[4]).toContain('.open(...["/week?sheet=new-habit"])');
    await d.close();
  });

  it('waitFor polls until the expression is truthy, and says what it waited for when it is not', async () => {
    let calls = 0;
    answer = r => (r.op === 'eval' ? { ok: true, value: ++calls >= 3 } : { ok: true, value: null });
    const d = await createDriver(context());
    await d.waitFor('window.ready');
    expect(calls).toBe(3);
    answer = r => (r.op === 'eval' ? { ok: true, value: false } : { ok: true, value: null });
    await expect(d.waitFor('window.never', { timeoutMs: 300 })).rejects.toThrow(/timed out waiting for window.never/);
    await d.close();
  });

  it('a screenshot is the app\'s own, written by the app into the run directory', async () => {
    const d = await createDriver(context());
    const path = await d.screenshot('first-screen');
    expect(path).toBe(join(dir, 'artifacts', 'devtest', 'run', 'first-screen.png'));
    expect(requests.at(-1)).toMatchObject({ op: 'screenshot', path });
    await d.close();
  });

  it('refuses to start when the app has no channel directory, and says what to do', async () => {
    rmSync(join(dir, 'droid-kit'), { recursive: true });
    await expect(createDriver(context())).rejects.toThrow(/dk run linux-desktop/);
  });

  it('a notification that is not in the app\'s reminders cannot be tapped, and the error says why', async () => {
    const d = await createDriver(context());
    await expect(d.tapNotification({ title: 'No such reminder' })).rejects.toThrow(/not in the app's reminders.json/);
    await d.close();
  });
});

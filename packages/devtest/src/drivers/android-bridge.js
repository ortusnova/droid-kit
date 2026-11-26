// The Android driver's bridge: one small Node program that runs where `adb` and the
// WebView's DevTools socket are reachable. For the phone that is this computer; for the
// emulator it is the container on the build host (its adb server and the forwarded
// ports live inside it), so the driver starts the bridge there with
// `ssh <host> apodman exec -i … node` and talks to it in the same way.
//
// Protocol: one JSON object per line on stdin, one reply per line on stdout.
//   { id, op: 'init', adb, serial }                          -> { id, ok: true }
//   { id, op: 'adb', args: [...], binary?, timeoutMs?, stdin? } -> { id, ok: true, code, stdout, stderr }   (stdout base64 when binary)
//   { id, op: 'eval', pkg, expression, timeoutMs? }            -> { id, ok: true, value } | { id, ok: false, error }
// Nothing else is written to stdout. Plain JavaScript with no imports but Node's own,
// because it is sent as text.

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

let adbPath = 'adb';
/** @type {string | null} */
let serial = null;
/** @type {Map<string, { pid: string, port: number }>} */
const forwards = new Map();

/** @param {string[]} args @param {{ timeoutMs?: number, stdin?: string }} [options] */
function runAdb(args, options = {}) {
  return new Promise(resolve => {
    const full = serial ? ['-s', serial, ...args] : args;
    const child = spawn(adbPath, full, { stdio: ['pipe', 'pipe', 'pipe'] });
    /** @type {Buffer[]} */
    const out = [];
    /** @type {Buffer[]} */
    const err = [];
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? 60_000);
    child.stdout.on('data', d => out.push(d));
    child.stderr.on('data', d => err.push(d));
    child.on('error', e => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: Buffer.alloc(0), stderr: Buffer.from(String(e)) });
    });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout: Buffer.concat(out), stderr: Buffer.concat(err) });
    });
    if (options.stdin !== undefined) child.stdin.end(options.stdin);
    else child.stdin.end();
  });
}

/** The DevTools port for the app's current process, forwarding it if it is new. @param {string} pkg */
async function devtoolsPort(pkg) {
  const pid = (await runAdb(['shell', 'pidof', pkg])).stdout.toString().trim().split(/\s+/)[0];
  if (!pid) throw new Error(`${pkg} is not running`);
  const known = forwards.get(pkg);
  if (known && known.pid === pid) return known.port;
  const r = await runAdb(['forward', 'tcp:0', `localabstract:webview_devtools_remote_${pid}`]);
  const port = Number(r.stdout.toString().trim());
  if (!port) throw new Error(`adb forward failed: ${r.stderr.toString().trim() || r.stdout.toString().trim()}`);
  forwards.set(pkg, { pid, port });
  return port;
}

/** Evaluates in the app's page over the DevTools protocol, on a fresh connection (a reload invalidates the old one). @param {string} pkg @param {string} expression @param {number} timeoutMs */
async function evaluate(pkg, expression, timeoutMs) {
  const port = await devtoolsPort(pkg);
  const targets = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(5000) }).then(r => r.json());
  const page = targets.find(/** @param {{ type: string }} t */ t => t.type === 'page');
  if (!page) throw new Error('the web view has no page yet');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('could not open the DevTools socket')), { once: true });
  });
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`the page did not answer within ${timeoutMs} ms`)), timeoutMs);
      ws.addEventListener('close', () => reject(new Error('the page closed the DevTools socket (it reloaded or the app stopped)')), { once: true });
      ws.addEventListener('message', e => {
        const m = JSON.parse(String(e.data));
        if (m.id !== 1) return;
        clearTimeout(timer);
        if (m.error) return reject(new Error(m.error.message));
        const r = m.result;
        if (r.exceptionDetails) return reject(new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
        resolve(r.result.value ?? null);
      });
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    });
  } finally {
    ws.close();
  }
}

/** @param {Record<string, any>} m */
async function handle(m) {
  switch (m.op) {
    case 'init':
      adbPath = m.adb || 'adb';
      serial = m.serial || null;
      return {};
    case 'adb': {
      const r = await runAdb(m.args, { timeoutMs: m.timeoutMs });
      return { code: r.code, stdout: m.binary ? r.stdout.toString('base64') : r.stdout.toString(), stderr: r.stderr.toString() };
    }
    case 'eval':
      return { value: await evaluate(m.pkg, m.expression, m.timeoutMs ?? 30_000) };
    default:
      throw new Error(`unknown op ${m.op}`);
  }
}

const lines = createInterface({ input: process.stdin });
lines.on('line', line => {
  /** @type {Record<string, any>} */
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  handle(m).then(
    r => process.stdout.write(`${JSON.stringify({ id: m.id, ok: true, ...r })}\n`),
    e => process.stdout.write(`${JSON.stringify({ id: m.id, ok: false, error: e instanceof Error ? e.message : String(e) })}\n`),
  );
});
lines.on('close', () => process.exit(0));

// Gallery checks (ui-components spec), in headless Chromium at 412 × 915:
//   - every interactive element's hit area is at least the touch-target token;
//   - a light and a dark screenshot of every gallery page.
//
//   node scripts/gallery-check.mjs [--inject-undersized]
//
// Builds the gallery, serves it with `vite preview`, visits every page, and
// writes screenshots to apps/gallery/artifacts/gallery-check/. Exits 1 if any
// element is too small. --inject-undersized adds a 20 px button to each page,
// to prove the check fails when it should.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const GALLERY = join(ROOT, 'apps/gallery');
const OUT = join(GALLERY, 'artifacts/gallery-check');
const inject = process.argv.includes('--inject-undersized');
const TARGET = JSON.parse(readFileSync(join(ROOT, 'packages/tokens/src/space.tokens.json'), 'utf8')).space['touch-target'].$value.value;
const PREVIEW = 5340;
const CDP = 9360;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const run = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: 'inherit', ...opts });
    p.on('exit', code => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} exited ${code}`))));
  });

// The check that runs in the page. Hit area: the element itself, or what
// receives the tap for it (a checkbox's label, a date segment's field).
const MEASURE = `(() => {
  const sel = 'button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=checkbox], [role=switch], [role=radio], [role=tab], [role=link], [role=spinbutton]';
  const out = [];
  for (const el of document.querySelectorAll(sel)) {
    if (el.closest('[aria-hidden=true], [inert]')) continue;
    let target = el;
    const r0 = el.getBoundingClientRect();
    const hidden = r0.width <= 1 || r0.height <= 1;
    if (el.getAttribute('role') === 'spinbutton') target = el.closest('.input') || el.parentElement;
    else if (hidden || (el.tagName === 'INPUT' && el.closest('label'))) target = el.closest('label') || el.parentElement;
    const r = target.getBoundingClientRect();
    // Nothing to tap: not rendered, or only for screen readers (visually hidden, 1 px).
    if (r.width <= 1 && r.height <= 1) continue;
    if (getComputedStyle(target).visibility === 'hidden') continue;
    if (r.width + 0.5 < ${TARGET} || r.height + 0.5 < ${TARGET}) {
      const name = (el.getAttribute('aria-label') || el.textContent || el.getAttribute('placeholder') || el.tagName).trim().slice(0, 40);
      out.push(name + ' (' + el.tagName.toLowerCase() + (el.getAttribute('role') ? '[role=' + el.getAttribute('role') + ']' : '') + ') ' + Math.round(r.width) + '×' + Math.round(r.height));
    }
  }
  return out;
})()`;

async function main() {
  await run('pnpm', ['build'], { cwd: GALLERY });
  const preview = spawn('pnpm', ['exec', 'vite', 'preview', '--port', String(PREVIEW), '--strictPort', '--host', '127.0.0.1'], { cwd: GALLERY, stdio: 'ignore' });
  const profile = mkdtempSync(join(tmpdir(), 'gallery-check-'));
  const chrome = spawn('chromium-browser', ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', `--user-data-dir=${profile}`, `--remote-debugging-port=${CDP}`, 'about:blank'], { stdio: 'ignore' });
  mkdirSync(OUT, { recursive: true });
  const problems = [];
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
    ws.addEventListener('message', e => {
      const m = JSON.parse(e.data);
      if (m.id && pending.has(m.id)) {
        pending.get(m.id)(m);
        pending.delete(m.id);
      }
    });
    const send = (method, params = {}) => new Promise(r => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
    const evaluate = async expression => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
    const go = async url => {
      await send('Page.navigate', { url });
      for (let i = 0; i < 40; i++) {
        await sleep(100);
        if (await evaluate(`document.readyState === 'complete' && !!document.querySelector('#screen-title')`)) break;
      }
      await sleep(400);
    };

    await send('Emulation.setDeviceMetricsOverride', { width: 412, height: 915, deviceScaleFactor: 2, mobile: true });
    await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    await send('Page.enable');
    for (let i = 0; i < 50; i++) {
      await sleep(200);
      if (await fetch(`http://127.0.0.1:${PREVIEW}/`).then(r => r.ok).catch(() => false)) break;
    }

    const base = `http://127.0.0.1:${PREVIEW}`;
    await go(`${base}/components`);
    const names = await evaluate(`[...document.querySelectorAll('a[href^="/components/"]')].map(a => a.getAttribute('href'))`);
    const pages = ['/', '/design', '/components', ...names];

    for (const path of pages) {
      const slug = path === '/' ? 'platform' : path.slice(1).replace(/\//g, '-');
      for (const mode of ['light', 'dark']) {
        await go(`${base}/components`);
        await evaluate(`localStorage.setItem('dk.theme', '${mode}')`);
        await go(base + path);
        if (inject) await evaluate(`(() => { const b = document.createElement('button'); b.textContent = 'tiny'; b.style.cssText = 'width:20px;height:20px;font-size:8px'; document.querySelector('main').prepend(b); })()`);
        if (mode === 'light') {
          const small = await evaluate(MEASURE);
          for (const s of small) problems.push(`${path}: ${s}`);
        }
        const shot = await send('Page.captureScreenshot', { format: 'png' });
        writeFileSync(join(OUT, `${slug}-${mode}.png`), Buffer.from(shot.result.data, 'base64'));
      }
    }
    await evaluate(`localStorage.removeItem('dk.theme')`);
    ws.close();
    console.error(`checked ${pages.length} pages; screenshots in ${OUT}`);
  } finally {
    chrome.kill();
    preview.kill();
    await sleep(300);
    rmSync(profile, { recursive: true, force: true });
  }
  for (const p of problems) console.error(`problem: hit area below ${TARGET} px: ${p}`);
  if (!problems.length) console.error(`ok: every interactive element is at least ${TARGET} × ${TARGET} px`);
  process.exitCode = problems.length ? 1 : 0;
}

await main();

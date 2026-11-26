#!/usr/bin/env node
// Run by `dk test <target>`: loads the driver for the target and the app's
// scenarios in tests/device/, runs them, and writes RESULTS.md. Exit 0 when
// every scenario passed or was skipped, 1 when one failed, 2 when the run
// could not start (no driver for the target, no scenarios).

import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resultsMarkdown, runScenarios } from './index.js';

const DRIVER_OF = { 'android-phone': 'android', 'android-emulator': 'android', 'linux-desktop': 'linux', 'ios-phone': 'ios' };

async function main() {
  const raw = process.env.DK_TEST_CONTEXT;
  if (!raw) throw new Error('DK_TEST_CONTEXT is not set: run this through `dk test <target>`');
  /** @type {import('./index.js').TestContext} */
  const context = JSON.parse(raw);
  const only = process.env.DK_TEST_ONLY || undefined;

  const driverFile = new URL(`./drivers/${DRIVER_OF[context.target] ?? context.target}.js`, import.meta.url);
  if (!existsSync(driverFile)) {
    console.error(`dk test: ${context.target} has no driver yet`);
    return 2;
  }
  const dir = join(context.appDir, 'tests/device');
  const files = existsSync(dir) ? readdirSync(dir).filter(f => /\.(ts|js|mjs)$/.test(f) && !f.endsWith('.d.ts')).sort() : [];
  if (!files.length) {
    console.error(`dk test: no scenarios in ${relative(process.cwd(), dir) || dir}`);
    return 2;
  }
  const list = [];
  for (const f of files) {
    const mod = await import(pathToFileURL(join(dir, f)).href);
    for (const s of [mod.default].flat().filter(Boolean)) list.push({ file: `tests/device/${f}`, scenario: s });
  }

  mkdirSync(context.runDir, { recursive: true });
  const { createDriver } = await import(driverFile.href);
  const driver = await createDriver(context);
  const startedAt = new Date().toISOString();
  let results;
  try {
    results = await runScenarios(driver, list, { only });
  } finally {
    await driver.close();
  }
  for (const r of results) for (const st of r.steps) if (st.screenshot) st.screenshot = relative(context.runDir, st.screenshot);
  const md = resultsMarkdown({ target: context.target, inputLabel: driver.inputLabel, app: context.identifier, startedAt }, results);
  const out = join(context.runDir, 'RESULTS.md');
  writeFileSync(out, md);
  for (const r of results) console.log(`${r.outcome.toUpperCase().padEnd(4)} ${r.name}${r.reason ? `: ${r.reason}` : ''}`);
  console.log(`results: ${out}`);
  return results.some(r => r.outcome === 'fail') ? 1 : 0;
}

main().then(
  code => process.exit(code),
  e => {
    console.error(`dk test: ${e instanceof Error ? (e.stack ?? e.message) : e}`);
    process.exit(2);
  },
);

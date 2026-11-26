// Device scenarios: the scenario format, the runner and the results (types in index.d.ts).

/** @typedef {import('./index.js').Scenario} Scenario */
/** @typedef {import('./index.js').ScenarioResult} ScenarioResult */
/** @typedef {import('./index.js').StepResult} StepResult */

/**
 * @param {string} name
 * @param {{ needs?: import('./index.js').Capability[] } | ((t: import('./index.js').ScenarioContext) => Promise<void>)} a
 * @param {(t: import('./index.js').ScenarioContext) => Promise<void>} [b]
 * @returns {Scenario}
 */
export function scenario(name, a, b) {
  const [options, run] = typeof a === 'function' ? [{}, a] : [a, b];
  if (typeof run !== 'function') throw new TypeError(`scenario "${name}" has no body`);
  return Object.freeze({ name, needs: Object.freeze([...(options.needs ?? [])]), run });
}

class CheckFailed extends Error {}

/** @param {unknown} e */
const message = e => (e instanceof Error ? e.message : String(e));
/** @param {string} s */
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

/** @type {typeof import('./index.js').runScenarios} */
export async function runScenarios(driver, list, options = {}) {
  /** @type {ScenarioResult[]} */
  const results = [];
  for (const { file, scenario: s } of list) {
    if (options.only && !s.name.includes(options.only)) continue;
    const missing = s.needs.filter(c => !driver.capabilities.has(c));
    if (missing.length) {
      results.push({ name: s.name, file, outcome: 'skip', reason: `needs ${missing.join(', ')}`, steps: [], notes: [], ms: 0 });
      continue;
    }
    /** @type {StepResult[]} */
    const steps = [];
    /** @type {string[]} */
    const notes = [];
    const started = Date.now();
    let current = '(before the first step)';
    let stepIndex = 0;
    /** @type {import('./index.js').ScenarioContext} */
    const context = {
      d: driver,
      async step(name, run) {
        current = name;
        const t0 = Date.now();
        try {
          const value = await run();
          steps.push({ name, ok: true, ms: Date.now() - t0 });
          return value;
        } catch (e) {
          /** @type {StepResult} */
          const step = { name, ok: false, ms: Date.now() - t0, error: message(e) };
          try {
            step.screenshot = await driver.screenshot(`${slug(s.name)}-${String(++stepIndex).padStart(2, '0')}-failed`);
          } catch (shot) {
            step.error += ` (no screenshot: ${message(shot)})`;
          }
          steps.push(step);
          throw e;
        }
      },
      expect(name, actual, expected) {
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
          throw new CheckFailed(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
        }
      },
      note(text) {
        notes.push(text);
      },
    };
    try {
      // A driver can get the device ready (Android: wake the screen, close the shade).
      await driver.beforeScenario?.(s.name);
      await s.run(context);
      results.push({ name: s.name, file, outcome: 'pass', steps, notes, ms: Date.now() - started });
    } catch (e) {
      // A failure outside any step still names where the scenario was.
      if (!steps.some(st => !st.ok)) steps.push({ name: current, ok: false, ms: 0, error: message(e) });
      results.push({ name: s.name, file, outcome: 'fail', reason: `${current}: ${message(e)}`, steps, notes, ms: Date.now() - started });
    }
  }
  return results;
}

/** @param {unknown} s */
const cell = s => String(s).replaceAll('|', '\\|').replaceAll('\n', ' ');

/** @type {typeof import('./index.js').resultsMarkdown} */
export function resultsMarkdown(info, results) {
  /** @param {import('./index.js').Outcome} o */
  const count = o => results.filter(r => r.outcome === o).length;
  const lines = [
    `# Device scenarios: ${info.app} on ${info.target}`,
    '',
    `- Started: ${info.startedAt}`,
    `- Input: ${info.inputLabel}`,
    `- Result: ${count('fail') ? 'FAIL' : 'PASS'}: ${count('pass')} passed, ${count('fail')} failed, ${count('skip')} skipped`,
    '',
    '| Scenario | Result | Note | Time |',
    '|---|---|---|---|',
    ...results.map(r => `| ${cell(r.name)} | ${r.outcome.toUpperCase()} | ${cell(r.reason ?? '')} | ${(r.ms / 1000).toFixed(1)} s |`),
  ];
  for (const r of results) {
    if (r.outcome === 'skip') continue;
    lines.push('', `## ${r.name}`, '', `File: \`${r.file}\``, '');
    for (const st of r.steps) {
      const shot = st.screenshot ? ` ([screenshot](${st.screenshot}))` : '';
      lines.push(`- ${st.ok ? 'ok' : 'FAILED'}: ${st.name} (${st.ms} ms)${st.error ? `: ${st.error}` : ''}${shot}`);
    }
    for (const n of r.notes) lines.push(`- note: ${n}`);
  }
  return `${lines.join('\n')}\n`;
}

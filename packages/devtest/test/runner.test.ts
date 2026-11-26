import { describe, expect, it } from 'vitest';
import { resultsMarkdown, runScenarios, scenario, type Capability, type Driver } from '../src/index.js';

function fakeDriver(capabilities: Capability[] = []): Driver & { shots: string[]; taps: string[] } {
  const shots: string[] = [];
  const taps: string[] = [];
  const noop = async () => {};
  return {
    target: 'fake',
    capabilities: new Set(capabilities),
    inputLabel: 'fake input',
    shots,
    taps,
    open: noop,
    tap: async s => void taps.push(s),
    swipe: noop,
    type: noop,
    back: noop,
    eval: async <T,>(e: string) => (e === '1+1' ? 2 : null) as T,
    waitFor: noop,
    screenshot: async name => {
      shots.push(name);
      return `/run/${name}.png`;
    },
    forceStop: noop,
    restart: noop,
    reinstall: noop,
    waitForNotification: noop,
    tapNotification: noop,
    close: noop,
  };
}

const passing = scenario('taps the button', async t => {
  await t.step('tap', () => t.d.tap('#fab'));
  const v = await t.step('read', () => t.d.eval<number>('1+1'));
  t.expect('sum', v, 2);
});

const failing = scenario('a false check', async t => {
  await t.step('open', () => t.d.open('/'));
  await t.step('check the count', async () => t.expect('count', await t.d.eval('1+1'), 3));
  await t.step('never reached', () => t.d.tap('#x'));
});

const needsNotifications = scenario('taps a reminder', { needs: ['notifications', 'realInput'] }, async t => {
  await t.d.tapNotification({ id: 'habit-x' });
});

describe('runScenarios', () => {
  it('passes a scenario whose steps and checks hold', async () => {
    const d = fakeDriver();
    const [r] = await runScenarios(d, [{ file: 'tests/device/a.ts', scenario: passing }]);
    expect(r.outcome).toBe('pass');
    expect(r.steps.map(s => [s.name, s.ok])).toEqual([['tap', true], ['read', true]]);
    expect(d.taps).toEqual(['#fab']);
    expect(d.shots).toEqual([]);
  });

  it('fails at the step whose check does not hold, with a screenshot, and stops there', async () => {
    const d = fakeDriver();
    const [r] = await runScenarios(d, [{ file: 'tests/device/b.ts', scenario: failing }]);
    expect(r.outcome).toBe('fail');
    expect(r.reason).toBe('check the count: count: expected 3, got 2');
    const failed = r.steps.find(s => !s.ok)!;
    expect(failed.name).toBe('check the count');
    expect(failed.screenshot).toBe('/run/a-false-check-01-failed.png');
    expect(r.steps.map(s => s.name)).not.toContain('never reached');
  });

  it('skips a scenario whose needs the driver lacks, naming what is missing', async () => {
    const [r] = await runScenarios(fakeDriver(['realInput']), [{ file: 'tests/device/c.ts', scenario: needsNotifications }]);
    expect(r).toMatchObject({ outcome: 'skip', reason: 'needs notifications', steps: [] });
    const [ran] = await runScenarios(fakeDriver(['realInput', 'notifications']), [{ file: 'c', scenario: needsNotifications }]);
    expect(ran.outcome).toBe('pass');
  });

  it('runs only the scenarios whose name contains --only', async () => {
    const all = [passing, failing].map(s => ({ file: 'f', scenario: s }));
    const rs = await runScenarios(fakeDriver(), all, { only: 'taps' });
    expect(rs.map(r => r.name)).toEqual(['taps the button']);
  });

  it('keeps a failure outside any step, naming the last step', async () => {
    const s = scenario('throws between steps', async t => {
      await t.step('first', async () => {});
      throw new Error('boom');
    });
    const [r] = await runScenarios(fakeDriver(), [{ file: 'f', scenario: s }]);
    expect(r).toMatchObject({ outcome: 'fail', reason: 'first: boom' });
  });
});

describe('resultsMarkdown', () => {
  it('summarises, labels the input, and lists the steps with the failure screenshot', async () => {
    const results = await runScenarios(fakeDriver(), [
      { file: 'tests/device/a.ts', scenario: passing },
      { file: 'tests/device/b.ts', scenario: failing },
      { file: 'tests/device/c.ts', scenario: needsNotifications },
    ]);
    const md = resultsMarkdown({ target: 'linux-desktop', inputLabel: 'inside the page, not pointer input', app: 'com.example', startedAt: '2026-11-26T12:00:00Z' }, results);
    expect(md).toContain('# Device scenarios: com.example on linux-desktop');
    expect(md).toContain('- Input: inside the page, not pointer input');
    expect(md).toContain('- Result: FAIL: 1 passed, 1 failed, 1 skipped');
    expect(md).toMatch(/\| taps a reminder \| SKIP \| needs notifications, realInput \|/);
    expect(md).toContain('- FAILED: check the count');
    expect(md).toContain('([screenshot](/run/a-false-check-01-failed.png))');
  });
});

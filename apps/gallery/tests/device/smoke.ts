// The smoke scenario every target shares: a press on the floating action button, a sheet closed by back,
// and a stop and restart. Run it with `dk test android-phone`, `android-emulator` or `linux-desktop`.
//
// DK_TEST_FAIL=1 adds a check that is false on purpose, to show what a failing run looks like.
import { scenario } from '@droid-kit/devtest';

export default scenario('smoke: floating action button, sheet, restart', async t => {
  const { d } = t;

  await t.step('open the floating action button page', () => d.open('/components/fab'));
  await t.step('wait for the page', () => d.waitFor(`document.querySelector('#fab-presses') !== null`));
  await t.step('the counter starts at 0', async () => t.expect('counter', await d.eval(`document.querySelector('#fab-presses').textContent`), 'Pressed 0 times'));

  await t.step('tap the floating action button', () => d.tap('button[aria-label="New habit"]'));
  await t.step('the counter says "Pressed 1 times"', async () => {
    await d.waitFor(`document.querySelector('#fab-presses').textContent === 'Pressed 1 times'`);
    await d.screenshot('fab-pressed');
  });

  await t.step('open the sheet page', () => d.open('/components/sheet'));
  await t.step('wait for the page', () => d.waitFor(`document.querySelector('#open-sheet') !== null`));
  await t.step('tap "Open the sheet"', () => d.tap('#open-sheet'));
  await t.step('the sheet is open, and on the screen', async () => {
    // Present in the page is not enough: a sheet that is stuck entering (react-spectrum 10937) stays below the screen. The sheet's content area is the visible part: the panel around it can be taller than the screen.
    await d.waitFor(
      `location.search === '?sheet=demo' && (() => { const s = document.querySelector('.dk-sheet-content'); if (!s) return false; const r = s.getBoundingClientRect(); return r.height > 0 && r.top >= -1 && r.bottom <= innerHeight + 1; })()`,
    );
    await d.screenshot('sheet-open');
  });
  await t.step('back closes the sheet', async () => {
    await d.back();
    await d.waitFor(`location.search === '' && document.querySelector('.dk-sheet-overlay') === null`);
    await d.screenshot('sheet-closed');
  });

  await t.step('force-stop the app', () => d.forceStop());
  await t.step('restart it', () => d.restart());
  await t.step('the first screen shows', async () => {
    await d.waitFor(`document.querySelector('[data-scroll-restoration-id="main"]') !== null && document.body.innerText.includes('Platform')`);
    await d.screenshot('first-screen-after-restart');
  });

  if (process.env.DK_TEST_FAIL) {
    await t.step('a check that is false on purpose (DK_TEST_FAIL)', async () => t.expect('two plus two', 2 + 2, 5));
  }
});

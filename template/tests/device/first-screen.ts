// A device scenario: run with `dk test android-phone` (or android-emulator, linux-desktop, ios-phone).
// Each file default-exports one scenario or an array; see @droid-kit/devtest in the kit's README.
import { scenario } from '@droid-kit/devtest';

export default scenario('the first screen shows, and the database opens', async t => {
  await t.step('open the start screen', () => t.d.open('/'));
  await t.step('wait for the page', () => t.d.waitFor(`document.querySelector('[data-scroll-restoration-id="main"]') !== null`));
  await t.step('screenshot', () => t.d.screenshot('first-screen'));
  await t.step('open About, which opens the database', () => t.d.open('/about'));
  await t.step('the database is open', async () => {
    await t.d.waitFor(`document.querySelector('[data-database]')?.dataset.database !== 'opening'`);
    t.expect('database', await t.d.eval(`document.querySelector('[data-database]').dataset.database`), 'open');
    t.note(await t.d.eval<string>(`document.querySelector('[data-database]').textContent`));
  });
  await t.step('screenshot', () => t.d.screenshot('about-database'));
});

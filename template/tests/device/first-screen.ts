// A device scenario: run with `dk test android-phone` (or android-emulator, linux-desktop).
// Each file default-exports one scenario or an array; see @droid-kit/devtest in the kit's README.
import { scenario } from '@droid-kit/devtest';

export default scenario('the first screen shows', async t => {
  await t.step('open the start screen', () => t.d.open('/'));
  await t.step('wait for the page', () => t.d.waitFor(`document.querySelector('[data-scroll-restoration-id="main"]') !== null`));
  await t.step('screenshot', () => t.d.screenshot('first-screen'));
});

// The example in the README's "Device scenarios" section. packages/devtest/test/readme.test.ts keeps the two the same.
import { scenario } from '@droid-kit/devtest';

export default scenario('the floating action button counts presses', async t => {
  const { d } = t;

  await t.step('open the page', async () => {
    await d.open('/components/fab');
    await d.waitFor(`document.querySelector('#fab-presses') !== null`);
  });

  await t.step('press the button twice', async () => {
    await d.tap('button[aria-label="New habit"]');
    await d.tap('button[aria-label="New habit"]');
    await d.waitFor(`document.querySelector('#fab-presses').textContent === 'Pressed 2 times'`);
    t.expect('counter', await d.eval(`document.querySelector('#fab-presses').textContent`), 'Pressed 2 times');
    await d.screenshot('fab-pressed-twice');
  });

  // Leaving the page unmounts it, so the next scenario to open it finds its counter at 0.
  await t.step('leave the page', () => d.open('/'));

  t.note('the page has a light and a dark sample; a tap goes to the first button it finds');
});

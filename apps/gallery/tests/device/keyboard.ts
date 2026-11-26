// A text field low in a sheet, with the on-screen keyboard up: the field must stay above the keyboard, and the
// sheet must stay on the screen. Run it with `dk test android-phone`, `android-emulator` or `linux-desktop` (no keyboard there).
import { scenario } from '@droid-kit/devtest';

const FIELD = '.dk-sheet-content input[placeholder^="Near the bottom"]';

export default scenario('keyboard: a field near the bottom of a sheet stays above the keyboard', async t => {
  const { d } = t;

  await t.step('open the sheet', async () => {
    await d.open('/components/sheet');
    await d.waitFor(`document.querySelector('#open-sheet') !== null`);
    await d.tap('#open-sheet');
    await d.waitFor(`(() => { const s = document.querySelector('.dk-sheet-content'); if (!s) return false; const r = s.getBoundingClientRect(); return r.height > 0 && r.top >= -1 && r.bottom <= innerHeight + 1; })()`);
  });
  await t.step('type into the field: it is above the keyboard', async () => {
    await d.type(FIELD, 'Evening walk 6.45');
    t.expect('typed', await d.eval(`document.querySelector(${JSON.stringify(FIELD)}).value`), 'Evening walk 6.45');
    // The keyboard shrinks the visual viewport; the field's bottom must be inside it (the sheet scrolls it into view).
    const m = await d.eval<{ fieldBottom: number; viewportBottom: number; keyboard: boolean }>(
      `(() => { const v = window.visualViewport ?? { offsetTop: 0, height: innerHeight }; return { fieldBottom: Math.round(document.querySelector(${JSON.stringify(FIELD)}).getBoundingClientRect().bottom), viewportBottom: Math.round(v.offsetTop + v.height), keyboard: v.height < innerHeight - 100 }; })()`,
    );
    t.note(`field bottom ${m.fieldBottom}, visual viewport bottom ${m.viewportBottom}${m.keyboard ? ' (keyboard up)' : ' (no keyboard)'}`);
    await d.screenshot('field-above-keyboard');
    if (!(m.fieldBottom <= m.viewportBottom)) throw new Error(`the field's bottom (${m.fieldBottom}) is below the visible viewport's bottom (${m.viewportBottom}): the keyboard covers it`);
  });
  await t.step('Back closes the keyboard, then the sheet', async () => {
    if (d.hideKeyboard) await d.hideKeyboard();
    await d.back();
    await d.waitFor(`location.search === '' && document.querySelector('.dk-sheet-overlay') === null`, { timeoutMs: 10_000 });
  });
});

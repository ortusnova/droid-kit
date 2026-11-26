// Pure helpers of the Android driver, kept apart so they can be tested without a device.

/** Java's `String.hashCode()`, which the reminders plugin uses for a notification's id: `("dk-reminder:" + id).hashCode()`. @param {string} s */
export function javaHash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

/** The notification id the reminders plugin gives a reminder. @param {string} reminderId */
export const notificationId = reminderId => javaHash(`dk-reminder:${reminderId}`);

const PLAIN = /^[A-Za-z0-9 .,:;@_/+=\-]*$/;

/**
 * The argument for `adb shell input text`, which takes `%s` for a space and stops at most shell characters.
 * Only plain text is supported: letters, digits, space and `. , : ; @ _ / + = -`. Anything else throws,
 * so a scenario never types something other than what it meant to.
 * @param {string} text
 */
export function inputText(text) {
  if (!PLAIN.test(text)) {
    const bad = [...text].find(c => !PLAIN.test(c));
    throw new Error(`the Android driver types plain text only (letters, digits, space and . , : ; @ _ / + = -); it cannot type ${JSON.stringify(bad)}`);
  }
  return text.replace(/ /g, '%s');
}

/**
 * The shown notifications of one package, from `dumpsys notification --noredact`.
 * @param {string} dump @param {string} pkg
 * @returns {{ id: number, title: string, text: string }[]}
 */
export function parseNotifications(dump, pkg) {
  const out = [];
  for (const record of dump.split(/^\s*NotificationRecord\(/m).slice(1)) {
    const head = record.slice(0, record.indexOf('\n') >= 0 ? record.indexOf('\n') : undefined);
    if (!new RegExp(`\\bpkg=${pkg.replace(/\./g, '\\.')}\\b`).test(head)) continue;
    const id = /\bid=(-?\d+)\b/.exec(head);
    const title = /android\.title=\w+ \((.*)\)/.exec(record);
    // The group's summary has no title of its own.
    if (!id || !title) continue;
    const text = /android\.text=\w+ \((.*)\)/.exec(record);
    out.push({ id: Number(id[1]), title: title[1], text: text?.[1] ?? '' });
  }
  return out;
}

/** @param {{ id: number, title: string }} n @param {{ id?: string, title?: string }} match */
export function matches(n, match) {
  if (match.id !== undefined && n.id !== notificationId(match.id)) return false;
  if (match.title !== undefined && n.title !== match.title) return false;
  return match.id !== undefined || match.title !== undefined;
}

/** @param {string} s */
const unescapeXml = s => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/**
 * The nodes of a `uiautomator dump`: text, content description, id, whether clickable, and the middle of its bounds.
 * @param {string} xml
 * @returns {{ text: string, desc: string, resourceId: string, clickable: boolean, x: number, y: number, bounds: [number, number, number, number] }[]}
 */
export function parseUiNodes(xml) {
  const nodes = [];
  for (const tag of xml.match(/<node\b[^>]*>/g) ?? []) {
    const attr = (/** @type {string} */ name) => unescapeXml(new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1] ?? '');
    const b = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(attr('bounds'));
    if (!b) continue;
    const [x1, y1, x2, y2] = [Number(b[1]), Number(b[2]), Number(b[3]), Number(b[4])];
    /** @type {[number, number, number, number]} */
    const box = [x1, y1, x2, y2];
    nodes.push({ text: attr('text'), desc: attr('content-desc'), resourceId: attr('resource-id'), clickable: attr('clickable') === 'true', x: Math.round((x1 + x2) / 2), y: Math.round((y1 + y2) / 2), bounds: box });
  }
  return nodes;
}

/**
 * Where to tap for a notification with this title in the shade: the node whose text is the title, or one that
 * starts with it (a notification can show "title text" in one view). Null if it is not on the screen.
 * @param {ReturnType<typeof parseUiNodes>} nodes @param {string} title
 */
export function findTitle(nodes, title) {
  return nodes.find(n => n.text === title) ?? nodes.find(n => n.text.startsWith(`${title} `) || n.desc.startsWith(title)) ?? null;
}

/**
 * The control that expands a collapsed group of notifications, if the screen has one above `belowY`: the nearest
 * such control above that line (the group's header row). A single notification's own chevron is on its title's row, not above it.
 * @param {ReturnType<typeof parseUiNodes>} nodes @param {number} belowY
 */
export function findExpander(nodes, belowY) {
  const above = nodes.filter(n => /expand_button$/.test(n.resourceId) && n.desc.toLowerCase() === 'expand' && n.y < belowY - 40);
  return above.sort((a, b) => b.y - a.y)[0] ?? null;
}

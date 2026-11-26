// Fails if a component source contains a colour literal: every colour must
// come from the generated design tokens (ui-components spec).
//
//   node scripts/check-colours.mjs
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const DIRS = ['packages/ui/src'];
const LITERAL = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|hwb|lab|lch)\(/g;

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else if (/\.(tsx?|css)$/.test(name)) yield path;
  }
}

const problems = [];
for (const dir of DIRS) {
  for (const file of files(join(ROOT, dir))) {
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      for (const m of line.matchAll(LITERAL)) problems.push(`${relative(ROOT, file)}:${i + 1}: colour literal ${m[0]}`);
    });
  }
}
for (const p of problems) console.error(`problem: ${p}`);
if (!problems.length) console.error(`ok: no colour literals in ${DIRS.join(', ')}`);
process.exitCode = problems.length ? 1 : 0;

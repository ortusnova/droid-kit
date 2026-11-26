// The kit's version, in every place it is written. One release tag versions
// the whole kit (kit-distribution spec), and `dk new` pins the tag
// `v<version of dk>`, so a release is:
//
//   node scripts/set-version.mjs 0.1.0      # edit every manifest, then update Cargo.lock
//   git commit -am "Release 0.1.0" && git tag v0.1.0
//
//   node scripts/set-version.mjs --check    # every place agrees (`dk check` in the kit runs this)
//
// The version may carry a pre-release part, as in 0.1.0-rc.1.
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = new URL('..', import.meta.url).pathname;
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const read = p => readFileSync(join(ROOT, p), 'utf8');

// [file, pattern with the version in group 2, what it is]
const places = [
  ['Cargo.toml', /(\[workspace\.package\]\nversion = ")([^"]+)(")/, 'Cargo workspace version'],
  ['package.json', /("version": ")([^"]+)(")/, 'root package.json'],
  ['apps/gallery/package.json', /("version": ")([^"]+)(")/, 'gallery package.json'],
  ['apps/gallery/src-tauri/tauri.conf.json', /("version": ")([^"]+)(")/, 'gallery tauri.conf.json'],
  ...readdirSync(join(ROOT, 'packages')).flatMap(d => {
    const pkg = `packages/${d}/package.json`;
    const index = `packages/${d}/src/index.ts`;
    return [
      [pkg, /("version": ")([^"]+)(")/, `${d} package.json`],
      ...(existsSync(join(ROOT, index)) && /export const VERSION/.test(read(index)) ? [[index, /(export const VERSION = ')([^']+)(')/, `${d} VERSION`]] : []),
    ];
  }),
  ['README.md', /(cargo install --git https:\/\/github\.com\/ortusnova\/droid-kit --tag v)([^ ]+)( dk)/, 'README install command'],
];

/** Versions of the workspace's own crates in Cargo.lock (packages without a source). */
function lockVersions() {
  return [...read('Cargo.lock').matchAll(/\[\[package\]\]\nname = "([^"]+)"\nversion = "([^"]+)"\n(source = )?/g)]
    .filter(m => !m[3] && (m[1].startsWith('droid-kit-') || m[1] === 'dk' || m[1] === 'gallery'))
    .map(m => [m[1], m[2]]);
}

const arg = process.argv[2];
if (arg === '--check') {
  const want = read('Cargo.toml').match(places[0][1])[2];
  const bad = [];
  for (const [file, re, what] of places) {
    const got = read(file).match(re)?.[2];
    if (got !== want) bad.push(`${what} (${file}) is ${got ?? 'missing'}, not ${want}`);
  }
  for (const [name, v] of lockVersions()) if (v !== want) bad.push(`Cargo.lock has ${name} ${v}, not ${want}`);
  if (bad.length) {
    console.error(`problem: the kit's version differs between files; run node scripts/set-version.mjs ${want}\n  ${bad.join('\n  ')}`);
    process.exit(1);
  }
  console.error(`ok: kit version ${want} everywhere`);
} else if (arg && SEMVER.test(arg)) {
  for (const [file, re] of places) {
    const text = read(file);
    if (!re.test(text)) throw new Error(`${file}: no version found`);
    writeFileSync(join(ROOT, file), text.replace(re, `$1${arg}$3`));
  }
  const r = spawnSync('cargo', ['update', '--workspace', '--offline'], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
  console.error(`kit version is now ${arg}; \`dk new\` from this commit pins v${arg}`);
} else {
  console.error('usage: node scripts/set-version.mjs <X.Y.Z[-pre]> | --check');
  process.exit(2);
}

// Writes the options chosen on the gallery's Design page into the token
// source, then regenerates every output.
//
//   node packages/tokens/scripts/apply-choices.ts <choices.json>
//
// choices.json: { "chosenAt": "<ISO date>", "choices": { "<decision id>": "<option id>", ... } }
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KIT_ROOT, contrastProblems, outputs, readSources, resolve } from './generate.ts';

type Json = Record<string, unknown>;
export interface Option { id: string; label: string; tokens: Record<string, unknown> }
export interface Decision { id: string; title: string; options: Option[] }
export interface Choices { chosenAt: string; choices: Record<string, string> }

const EXT = 'com.ortusnova.droidkit';
const FILE_BY_ROOT: Record<string, string> = {
  radius: 'shape.tokens.json',
  size: 'shape.tokens.json',
  space: 'space.tokens.json',
  font: 'type.tokens.json',
  motion: 'motion.tokens.json',
  color: 'color.tokens.json',
};

export function readDecisions(): Decision[] {
  return (JSON.parse(readFileSync(join(KIT_ROOT, 'packages/tokens/options.json'), 'utf8')) as { decisions: Decision[] }).decisions;
}

function hexToColor(hex: string) {
  const h = hex.replace('#', '').toLowerCase();
  return { colorSpace: 'srgb', components: [0, 2, 4].map(i => Math.round((parseInt(h.slice(i, i + 2), 16) / 255) * 10000) / 10000), hex: `#${h}` };
}

/** Applies choices to parsed sources in place. Returns a line per change made. */
export function applyChoices(sources: Record<string, Json>, decisions: Decision[], choices: Choices): string[] {
  const log: string[] = [];
  // chosenAt is UTC; the note uses the local date of whoever applies it.
  const date = new Date(choices.chosenAt).toLocaleDateString('en-CA');
  for (const [decisionId, optionId] of Object.entries(choices.choices)) {
    const decision = decisions.find(d => d.id === decisionId);
    if (!decision) throw new Error(`unknown decision ${decisionId}`);
    const option = decision.options.find(o => o.id === optionId);
    if (!option) throw new Error(`decision ${decisionId} has no option ${optionId}`);
    for (const [rawPath, value] of Object.entries(option.tokens)) {
      const dark = rawPath.endsWith('@dark');
      const path = rawPath.replace(/@dark$/, '');
      const file = FILE_BY_ROOT[path.split('.')[0]];
      if (!file) throw new Error(`no source file for token ${path}`);
      let node = sources[file] as Json;
      for (const k of path.split('.')) node = node[k] as Json;
      if (!node) throw new Error(`token ${path} is missing`);
      const note = `Chosen by Brian on ${date}: ${decision.title} → ${option.label}.`;
      const desc = typeof node.$description === 'string' ? node.$description.replace(/ ?Chosen by Brian on [^.]*→[^.]*\./g, '') : '';
      node.$description = desc ? `${desc} ${note}` : note;
      if (dark) {
        ((node.$extensions as Json)[EXT] as Json).dark = hexToColor(value as string);
      } else {
        node.$value = typeof value === 'string' && value.startsWith('#') ? hexToColor(value) : value;
      }
      log.push(`${rawPath} = ${JSON.stringify(value)} (${decision.title}: ${option.label})`);
    }
  }
  return log;
}

function main(): number {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: apply-choices.ts <choices.json>');
    return 2;
  }
  const choices = JSON.parse(readFileSync(file, 'utf8')) as Choices;
  const sources = readSources();
  for (const line of applyChoices(sources, readDecisions(), choices)) console.error(`set ${line}`);
  const tokens = resolve(sources);
  const problems = contrastProblems(tokens);
  if (problems.length) {
    for (const p of problems) console.error(`problem: ${p}`);
    console.error('not applied: the choices fail the contrast check');
    return 1;
  }
  for (const [name, json] of Object.entries(sources)) {
    writeFileSync(join(KIT_ROOT, 'packages/tokens/src', name), JSON.stringify(json, null, 2) + '\n');
  }
  for (const [path, content] of outputs(tokens)) writeFileSync(join(KIT_ROOT, path), content);
  console.error('applied; token source and generated files updated');
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = main();

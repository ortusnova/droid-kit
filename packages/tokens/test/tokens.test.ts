import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import {
  KIT_ROOT,
  PAIRS,
  contrast,
  contrastProblems,
  outputs,
  readSources,
  resolve,
  staleOutputs,
} from '../scripts/generate.ts';

const schema = JSON.parse(readFileSync(new URL('../schema/dtcg-2025.10-format.json', import.meta.url), 'utf8'));
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
const validateFile = ajv.compile(schema);
const validateColor = ajv.getSchema('https://www.designtokens.org/schemas/2025.10/format/values/color.json');

describe('token source', () => {
  const files = readdirSync(new URL('../src', import.meta.url)).filter(f => f.endsWith('.tokens.json'));

  it('has the expected files', () => {
    expect(files.sort()).toEqual(['color.tokens.json', 'motion.tokens.json', 'shape.tokens.json', 'space.tokens.json', 'type.tokens.json']);
  });

  for (const f of files) {
    it(`${f} is valid DTCG 2025.10`, () => {
      const ok = validateFile(readSources()[f]);
      expect(validateFile.errors ?? []).toEqual([]);
      expect(ok).toBe(true);
    });
  }

  it('every dark colour value is a valid DTCG colour', () => {
    expect(validateColor).toBeDefined();
    const roles = (readSources()['color.tokens.json'].color as Record<string, { $extensions: Record<string, { dark: unknown }> }>);
    for (const [role, token] of Object.entries(roles)) {
      if (role.startsWith('$')) continue;
      const ok = validateColor!(token.$extensions['com.ortusnova.droidkit'].dark);
      expect({ role, errors: validateColor!.errors ?? [] }).toEqual({ role, errors: [] });
      expect(ok).toBe(true);
    }
  });

  it('the schema rejects a pre-2025.10 hex string colour', () => {
    expect(validateFile({ c: { $type: 'color', $value: '#38bdf8' } })).toBe(false);
  });
});

describe('generated outputs', () => {
  it('are reproducible', () => {
    expect([...outputs()]).toEqual([...outputs()]);
  });

  it('match the files on disk', () => {
    const read = (p: string) => readFileSync(join(KIT_ROOT, p), 'utf8');
    expect(staleOutputs(outputs(), read)).toEqual([]);
  });

  it('a hand edit is detected and named', () => {
    const expected = outputs();
    const read = (p: string) => (p.endsWith('theme.css') ? expected.get(p)!.replace('#155dfc', '#ff0000') : expected.get(p)!);
    expect(staleOutputs(expected, read)).toEqual(['packages/tokens/generated/theme.css']);
  });

  it('define every role in light and dark', () => {
    const t = resolve();
    expect(Object.keys(t.colors.dark).sort()).toEqual(Object.keys(t.colors.light).sort());
    expect(Object.keys(t.colors.light)).toHaveLength(20);
  });
});

describe('contrast', () => {
  it('every required pair passes in both modes', () => {
    expect(contrastProblems(resolve())).toEqual([]);
  });

  it('fails when muted text drops below 4.5:1', () => {
    const t = resolve();
    t.colors.light['text-muted'] = '#a1a1aa';
    const problems = contrastProblems(t);
    expect(problems.some(p => p.startsWith('light: text-muted on'))).toBe(true);
  });

  it('writes translucent colours as #rrggbbaa for CSS and #aarrggbb for Android', () => {
    const t = resolve();
    expect(t.colors.light.scrim).toBe('#00000066');
    expect(outputs(t).get('packages/tokens/generated/android/values/colors.xml')).toContain('<color name="dk_scrim">#66000000</color>');
  });

  it('computes WCAG ratios', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrast('#71717b', '#fafafa')).toBeCloseTo(4.62, 2);
  });

  it('covers text, muted text, controls and every on-colour', () => {
    const fgs = new Set(PAIRS.map(p => p[0]));
    for (const role of ['text', 'text-muted', 'control-border', 'on-accent', 'on-accent-soft', 'on-success', 'on-warning', 'on-danger']) {
      expect(fgs.has(role as never)).toBe(true);
    }
  });
});

describe('applying choices from the Design page', async () => {
  const { applyChoices, readDecisions } = await import('../scripts/apply-choices.ts');

  it('every option of every decision passes contrast once applied', () => {
    for (const d of readDecisions()) {
      for (const o of d.options) {
        const sources = readSources();
        applyChoices(sources, readDecisions(), { chosenAt: '2026-11-25T00:00:00Z', choices: { [d.id]: o.id } });
        expect({ option: `${d.id}/${o.id}`, problems: contrastProblems(resolve(sources)) }).toEqual({ option: `${d.id}/${o.id}`, problems: [] });
      }
    }
  });

  it('round-trips: the chosen values come out of the generator, with a dated note', () => {
    const sources = readSources();
    applyChoices(sources, readDecisions(), {
      chosenAt: '2026-11-26T09:00:00Z',
      choices: { radius: 'soft', spacing: 'roomy', type: 'large', motion: 'snappy', 'dark-accent': 'white-on-blue-600' },
    });
    const t = resolve(sources);
    expect(t.radius).toEqual({ selector: '0.5rem', field: '0.5rem', box: '1rem' });
    expect(t.spacingUnit).toBe('0.28125rem');
    expect(t.fontSize.body).toBe('1.0625rem');
    expect(t.duration).toEqual({ fast: 100, base: 150, slow: 220 });
    expect(t.colors.dark.accent).toBe('#155dfc');
    expect(t.colors.dark['on-accent']).toBe('#ffffff');
    expect(t.colors.light.accent).toBe('#155dfc');
    const field = ((sources['shape.tokens.json'].radius as Record<string, { $description: string }>).field).$description;
    expect(field).toContain('Chosen by Brian on 2026-11-26: Corner radius → Soft.');
    const css = outputs(t).get('packages/tokens/generated/theme.css')!;
    expect(css).toContain('--radius-field: 0.5rem;');
  });

  it('rejects an unknown option', () => {
    expect(() => applyChoices(readSources(), readDecisions(), { chosenAt: '2026-11-26', choices: { radius: 'blobby' } })).toThrow(/no option blobby/);
  });
});

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

// The README's example is a file in the gallery, so `pnpm -r typecheck` compiles it.
// This test keeps the two the same.
describe('the README example', () => {
  it('is the gallery file apps/gallery/src/readme-store-example.ts', () => {
    const readme = read('../../../README.md');
    const block = /<!-- store-example -->\n```ts\n([\s\S]*?)```/.exec(readme)?.[1];
    expect(block).toBeDefined();
    expect(block).toBe(read('../../../apps/gallery/src/readme-store-example.ts'));
  });
});

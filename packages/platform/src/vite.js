// Vite plugin: inlines the droid-kit boot script first in <head>, so it runs
// before the app bundle is requested. Plain JavaScript because Vite loads it
// from node_modules, where Node does not strip TypeScript types.
import { readFileSync } from 'node:fs';

const bootSource = readFileSync(new URL('./boot.cjs', import.meta.url), 'utf8');

/** @returns {import('vite').Plugin} */
export function droidKit() {
  return {
    name: 'droid-kit',
    transformIndexHtml() {
      return [{ tag: 'script', children: bootSource, injectTo: 'head-prepend' }];
    },
  };
}

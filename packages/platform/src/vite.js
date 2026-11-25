// Vite plugin: inlines the droid-kit boot script first in <head>, and makes
// the page's module scripts inert until the boot script has checked the
// engine. Plain JavaScript because Vite loads it from node_modules, where
// Node does not strip TypeScript types.
//
// A <script type="module"> in the HTML is fetched by the browser's preload
// scanner before any script runs, so an engine too old for the app would
// still download it. `type="dk/module"` is a type no browser knows, so it is
// neither fetched nor run; the boot script turns these back into module
// scripts, in document order, when the engine is supported.
import { readFileSync } from 'node:fs';

const bootSource = readFileSync(new URL('./boot.cjs', import.meta.url), 'utf8');

/** @returns {import('vite').Plugin} */
export function droidKit() {
  return {
    name: 'droid-kit',
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        return {
          html: html
            .replace(/<script type="module"/g, '<script type="dk/module"')
            .replace(/<link rel="modulepreload"/g, '<link rel="dk-modulepreload"'),
          tags: [{ tag: 'script', children: bootSource, injectTo: 'head-prepend' }],
        };
      },
    },
  };
}

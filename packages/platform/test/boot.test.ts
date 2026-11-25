import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
// boot.cjs is a classic script with a CommonJS export for tests.
const boot = require('../src/boot.cjs') as {
  boot(window: unknown): void;
  parseVersion(v: string): number[];
  compareVersion(a: number[], b: number[]): number;
  detectEngine(native: unknown, ua: string): { name: string; version: string | null };
  engineSupported(e: { name: string; version: string | null }): boolean;
  formFactor(platform: string, coarse: boolean, w: number, h: number): string;
  resolveTheme(preference: string, systemDark: boolean): string;
};

const PHONE_UA = 'Mozilla/5.0 (Linux; Android 10; K; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/157.0.0.0 Mobile Safari/537.36';
const OLD_PHONE_UA = PHONE_UA.replace('Chrome/157', 'Chrome/103');
const GTK_UA = 'Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/60.5 Safari/605.1.15';

describe('form factor', () => {
  it('is phone on Android whatever the screen', () => {
    expect(boot.formFactor('android', false, 1200, 2000)).toBe('phone');
  });
  it('is phone on Linux with touch and a 412 by 915 screen', () => {
    expect(boot.formFactor('linux', true, 412, 915)).toBe('phone');
  });
  it('is desktop on Linux with a mouse', () => {
    expect(boot.formFactor('linux', false, 412, 915)).toBe('desktop');
  });
  it('is desktop on Linux with touch on a large screen', () => {
    expect(boot.formFactor('linux', true, 1200, 800)).toBe('desktop');
  });
});

describe('engine', () => {
  it('reads the Android WebView major version from the reduced user agent', () => {
    expect(boot.detectEngine({ platform: 'android', engine: { name: 'android-webview', version: null } }, PHONE_UA)).toEqual({
      name: 'android-webview',
      version: '157',
    });
  });
  it('takes the WebKitGTK version from native code', () => {
    expect(boot.detectEngine({ platform: 'linux', engine: { name: 'webkitgtk', version: '2.54.2' } }, GTK_UA)).toEqual({
      name: 'webkitgtk',
      version: '2.54.2',
    });
  });
  it('enforces the minimums', () => {
    expect(boot.engineSupported({ name: 'android-webview', version: '103' })).toBe(false);
    expect(boot.engineSupported({ name: 'android-webview', version: '139' })).toBe(false);
    expect(boot.engineSupported({ name: 'android-webview', version: '140' })).toBe(true);
    expect(boot.engineSupported({ name: 'webkitgtk', version: '2.52.9' })).toBe(false);
    expect(boot.engineSupported({ name: 'webkitgtk', version: '2.54.0' })).toBe(true);
    expect(boot.engineSupported({ name: 'webkitgtk', version: '3.0.0' })).toBe(true);
  });
  it('lets unknown engines through', () => {
    expect(boot.engineSupported({ name: 'browser', version: null })).toBe(true);
  });
});

describe('theme', () => {
  it('follows the system unless overridden', () => {
    expect(boot.resolveTheme('system', true)).toBe('dark');
    expect(boot.resolveTheme('system', false)).toBe('light');
    expect(boot.resolveTheme('dark', false)).toBe('dark');
    expect(boot.resolveTheme('light', true)).toBe('light');
  });
});

function fakeWindow(ua: string, native: unknown, storage: Record<string, string> = {}) {
  const attrs: Record<string, string> = {};
  const html = {
    innerHTML: '',
    style: { colorScheme: '', setProperty: vi.fn() },
    setAttribute: (k: string, v: string) => (attrs[k] = v),
    getAttribute: (k: string) => attrs[k] ?? null,
  };
  const mq = (matches: boolean) => ({ matches, addEventListener: vi.fn() });
  return {
    attrs,
    html,
    window: {
      document: {
        documentElement: html,
        readyState: 'complete',
        querySelectorAll: () => [],
        addEventListener: vi.fn(),
        createElement: () => ({}),
      },
      navigator: { userAgent: ua },
      __DK_NATIVE__: native,
      screen: { width: 412, height: 892 },
      innerHeight: 891,
      matchMedia: (q: string) => mq(q.includes('coarse')),
      localStorage: { getItem: (k: string) => storage[k] ?? null, setItem: vi.fn(), removeItem: vi.fn() },
      stop: vi.fn(),
      CustomEvent: class {
        constructor(public type: string, public init: unknown) {}
      },
      dispatchEvent: vi.fn(),
    } as Record<string, unknown> & { stop: ReturnType<typeof vi.fn>; __DK__?: Record<string, unknown> },
  };
}

describe('boot', () => {
  it('shows the update screen and stops loading below the minimum', () => {
    const f = fakeWindow(OLD_PHONE_UA, { platform: 'android', engine: { name: 'android-webview', version: null } });
    boot.boot(f.window);
    expect(f.window.stop).toHaveBeenCalled();
    expect(f.html.innerHTML).toContain('Android System WebView');
    expect(f.html.innerHTML).toContain('version 103');
    expect(f.html.innerHTML).toContain('140 or newer');
  });

  it('honours the debug engine override only in debug builds', () => {
    const native = { platform: 'android', engine: { name: 'android-webview', version: null }, debug: true };
    const f = fakeWindow(PHONE_UA, native, { 'dk.debug.engineVersion': '103' });
    boot.boot(f.window);
    expect(f.window.stop).toHaveBeenCalled();
    const release = fakeWindow(PHONE_UA, { ...native, debug: false }, { 'dk.debug.engineVersion': '103' });
    boot.boot(release.window);
    expect(release.window.stop).not.toHaveBeenCalled();
  });

  it('sets platform, form factor and theme before the first paint', () => {
    const f = fakeWindow(PHONE_UA, { platform: 'android', engine: { name: 'android-webview', version: null } }, { 'dk.theme': 'dark' });
    boot.boot(f.window);
    expect(f.window.stop).not.toHaveBeenCalled();
    expect(f.attrs['data-platform']).toBe('android');
    expect(f.attrs['data-form-factor']).toBe('phone');
    expect(f.attrs['data-theme']).toBe('dark');
    expect(f.window.__DK__).toMatchObject({ platform: 'android', formFactor: 'phone', theme: 'dark', themePreference: 'dark' });
  });

  it('starts the inert module scripts in document order when the engine is supported', () => {
    const f = fakeWindow(PHONE_UA, { platform: 'android', engine: { name: 'android-webview', version: null } });
    const replaced: Array<{ type: string; src: string; async: boolean }> = [];
    const inert = ['/assets/a.js', '/assets/b.js'].map(src => ({
      src,
      text: '',
      crossOrigin: '',
      parentNode: { replaceChild: (n: { type: string; src: string; async: boolean }) => replaced.push(n) },
    }));
    const doc = f.window.document as Record<string, unknown>;
    doc.querySelectorAll = () => inert;
    doc.createElement = () => ({});
    boot.boot(f.window);
    expect(replaced.map(r => [r.type, r.src, r.async])).toEqual([
      ['module', '/assets/a.js', false],
      ['module', '/assets/b.js', false],
    ]);
  });

  it('starts nothing below the minimum', () => {
    const f = fakeWindow(OLD_PHONE_UA, { platform: 'android', engine: { name: 'android-webview', version: null } });
    const replaceChild = vi.fn();
    const doc = f.window.document as Record<string, unknown>;
    doc.querySelectorAll = () => [{ src: '/assets/a.js', parentNode: { replaceChild } }];
    boot.boot(f.window);
    expect(replaceChild).not.toHaveBeenCalled();
  });
});

describe('ES5', () => {
  it('the boot script parses as ECMAScript 5, so old engines can run it', async () => {
    const { parse } = await import('acorn');
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../src/boot.cjs', import.meta.url), 'utf8');
    expect(() => parse(source, { ecmaVersion: 5 })).not.toThrow();
  });
});

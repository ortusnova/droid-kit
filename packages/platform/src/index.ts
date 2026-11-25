import { invoke } from '@tauri-apps/api/core';
import { onBackButtonPress } from '@tauri-apps/api/app';

export const VERSION = '0.0.2';

export type Platform = 'android' | 'linux' | 'ios' | 'web' | (string & {});
export type FormFactor = 'phone' | 'desktop';
export type Theme = 'light' | 'dark';
export type ThemePreference = Theme | 'system';

export interface Engine {
  name: 'android-webview' | 'webkitgtk' | 'browser' | (string & {});
  version: string | null;
}

/** What the boot script found before the first paint. */
export interface Dk {
  platform: Platform;
  engine: Engine;
  formFactor: FormFactor;
  theme: Theme;
  themePreference: ThemePreference;
  debug: boolean;
  setThemePreference(preference: ThemePreference): void;
}

declare global {
  interface Window {
    __DK__?: Dk;
  }
  interface WindowEventMap {
    'dk:theme': CustomEvent<Theme>;
  }
}

const isTauri = '__TAURI_INTERNALS__' in globalThis;

/** The boot script's results. Throws if the droidKit() Vite plugin is missing. */
export function dk(): Dk {
  const value = window.__DK__;
  if (!value) throw new Error('droid-kit boot script did not run: add droidKit() to the Vite plugins');
  return value;
}

export function setThemePreference(preference: ThemePreference): void {
  dk().setThemePreference(preference);
}

/** Calls `listener` with the new theme whenever it changes. Returns an unsubscribe function. */
export function onThemeChange(listener: (theme: Theme) => void): () => void {
  const handler = (e: CustomEvent<Theme>) => listener(e.detail);
  addEventListener('dk:theme', handler);
  return () => removeEventListener('dk:theme', handler);
}

/**
 * Keeps the Android status and navigation bars in step with the theme: their
 * icons contrast with the page, and the window behind the page has the page's
 * background colour. The colour comes from the `--dk-system-bars` CSS variable.
 */
export function syncSystemBars(): () => void {
  const apply = () => {
    if (!isTauri || dk().platform !== 'android') return;
    const value = getComputedStyle(document.documentElement).getPropertyValue('--dk-system-bars').trim();
    invoke('plugin:droid-kit-platform|set_system_bars', {
      dark: dk().theme === 'dark',
      background: value ? toHex(value) : null,
      preference: dk().themePreference,
    }).catch(e =>
      console.error(`DK_ERROR set_system_bars: ${e}`),
    );
  };
  apply();
  return onThemeChange(apply);
}

/** Any CSS colour as `#rrggbb`, which is what Android parses. A canvas normalises it. */
function toHex(css: string): string {
  const ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) return css;
  ctx.fillStyle = '#000000';
  ctx.fillStyle = css;
  return String(ctx.fillStyle);
}

/** Sends the app to the background, as the system back action does on a start screen. */
export function moveToBackground(): Promise<void> {
  return isTauri ? invoke('plugin:droid-kit-platform|move_to_background') : Promise.resolve();
}

/**
 * Android back action: go back in the app's history if there is any,
 * otherwise send the app to the background. Each screen and each open sheet
 * is a history entry, so back closes the topmost sheet first.
 */
export async function installBackHandler(): Promise<() => void> {
  if (!isTauri || dk().platform !== 'android') return () => {};
  const listener = await onBackButtonPress(({ canGoBack }) => {
    if (canGoBack) history.back();
    else void moveToBackground();
  });
  return () => void listener.unregister();
}

/**
 * Tell `dk run` that the first screen has rendered. Call once, after the
 * first commit. Waits two frames so the content has been painted.
 */
export function signalReady(): void {
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      console.log('DK_READY');
      if (isTauri) invoke('plugin:droid-kit-platform|ready').catch(() => {});
    }),
  );
}

/** Send uncaught errors to the app's log, where `dk run` looks for them. */
export function reportErrors(): void {
  const send = (message: string) => {
    console.error(`DK_ERROR ${message}`);
    if (isTauri) invoke('plugin:droid-kit-platform|report_error', { message }).catch(() => {});
  };
  addEventListener('error', e => send(`${e.message} at ${e.filename}:${e.lineno}`));
  addEventListener('unhandledrejection', e => send(`unhandled rejection: ${String(e.reason)}`));
}

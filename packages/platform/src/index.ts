import { invoke } from '@tauri-apps/api/core';
import { onBackButtonPress } from '@tauri-apps/api/app';
import { runBackInterceptor } from './back';

export { pushBackInterceptor, runBackInterceptor } from './back';

export const VERSION = '0.1.1';

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
  /** Debug builds: the screen to open first, from `dk run --route`. */
  startRoute: string | null;
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

/**
 * Debug builds: open the screen `dk run --route` asked for, by replacing the
 * current history entry. Call before the router is created.
 */
export function applyStartRoute(): void {
  const route = window.__DK__?.startRoute;
  if (route) history.replaceState(null, '', route);
}

/** Sends the app to the background, as the system back action does on a start screen. */
export function moveToBackground(): Promise<void> {
  return isTauri ? invoke('plugin:droid-kit-platform|move_to_background') : Promise.resolve();
}

/**
 * Android back action: close the topmost overlay that has no history entry
 * (see `pushBackInterceptor`), otherwise go back in the app's history if there
 * is any, otherwise send the app to the background. Each screen and each open
 * sheet that the app keeps in the URL is a history entry, so back closes the
 * topmost sheet first.
 */
export async function installBackHandler(): Promise<() => void> {
  if (!isTauri || dk().platform !== 'android') return () => {};
  const listener = await onBackButtonPress(({ canGoBack }) => {
    if (runBackInterceptor()) return;
    if (canGoBack) history.back();
    else void moveToBackground();
  });
  return () => void listener.unregister();
}

/**
 * Tell `dk run` that the first screen has rendered. Call once, after the
 * first commit. Waits two frames so the content has been painted, but no
 * longer than a second: a window that is covered by another one gets no
 * frames, and `dk run` must not wait for them.
 */
export function signalReady(): void {
  let signalled = false;
  const signal = () => {
    if (signalled) return;
    signalled = true;
    console.log('DK_READY');
    if (isTauri) invoke('plugin:droid-kit-platform|ready').catch(() => {});
  };
  requestAnimationFrame(() => requestAnimationFrame(signal));
  setTimeout(signal, 1000);
}

/**
 * Writes an error to the app's log as `DK_ERROR <message>`, where `dk run`
 * looks for it. Newlines are folded so the message stays on one log line.
 */
export function reportError(message: string): void {
  const line = message.replace(/\s*\n\s*/g, ' | ');
  console.error(`DK_ERROR ${line}`);
  if (isTauri) invoke('plugin:droid-kit-platform|report_error', { message: line }).catch(() => {});
}

/** Send uncaught errors to the app's log, where `dk run` looks for them. */
export function reportErrors(): void {
  addEventListener('error', e => reportError(`${e.message} at ${e.filename}:${e.lineno}`));
  addEventListener('unhandledrejection', e => reportError(`unhandled rejection: ${String(e.reason)}`));
}

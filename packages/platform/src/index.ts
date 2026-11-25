import { invoke } from '@tauri-apps/api/core';

export const VERSION = '0.0.2';

const isTauri = '__TAURI_INTERNALS__' in globalThis;

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

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { droidKit } from '@droid-kit/platform/vite';

// Tauri serves the dev server to the device, so listen on all interfaces when
// TAURI_DEV_HOST is set (Android) and on localhost otherwise.
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [droidKit(), react()],
  clearScreen: false,
  server: {
    port: 5310,
    strictPort: true,
    host: host || '127.0.0.1',
    hmr: host ? { protocol: 'ws', host, port: 5311 } : undefined,
  },
  build: {
    target: 'es2023',
  },
});

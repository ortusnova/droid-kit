// The backend on a device: the `droid-kit-store` Tauri plugin.
import { commands } from './bindings';
import { StoreError, type Backend, type StoreErrorKind } from './backend';

const KINDS: StoreErrorKind[] = ['sql', 'empty', 'invalid', 'migration', 'too-new', 'not-open', 'platform'];

function asStoreError(e: unknown): StoreError {
  if (e instanceof StoreError) return e;
  if (typeof e === 'object' && e && 'kind' in e && KINDS.includes((e as { kind: StoreErrorKind }).kind)) {
    const { kind, message, version } = e as { kind: StoreErrorKind; message: string; version?: number };
    return new StoreError(kind, message, version);
  }
  return new StoreError('platform', String(e));
}

async function call<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    throw asStoreError(e);
  }
}

export const tauriBackend: Backend = {
  open: (name, migrations) => call(() => commands.open(name, migrations)),
  select: (sql, params) => call(() => commands.select(sql, params)),
  execute: (sql, params) => call(() => commands.execute(sql, params)),
  batch: async statements => {
    await call(() => commands.batch(statements.map(s => ({ sql: s.sql, params: s.params ?? [] }))));
  },
};

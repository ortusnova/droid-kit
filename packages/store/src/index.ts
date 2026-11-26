// Local storage: one SQLite database per app. See the kit README, "Storage".
//
//   const store = await openStore({ name: 'life', migrations: [`CREATE TABLE …`, `ALTER TABLE …`] });
//   const rows = await store.select<{ n: number }>('SELECT COUNT(*) AS n FROM habit');
//   await store.batch([{ sql: 'INSERT …', params: [1] }, { sql: 'UPDATE …', params: [2] }]);
import { v7 as uuidv7 } from 'uuid';
import { StoreError, type Backend, type BackendInfo, type Param, type Row, type Statement } from './backend';
import { tauriBackend } from './tauri';

export const VERSION = '0.2.0-rc.1';
export { StoreError, isBlankSql } from './backend';
export type { Backend, BackendInfo, Param, Row, Statement, StoreErrorKind } from './backend';
export * from './records';

/** A time-ordered unique identifier (UUIDv7): ids made later sort after ids made earlier. */
export function newId(): string {
  return uuidv7();
}

export interface OpenOptions {
  /** The database file is `<name>.db` in the app's data directory: letters, digits, `_` and `-`. */
  name: string;
  /**
   * The schema, as an ordered list of SQL scripts. Script *n* runs once, in one
   * transaction together with `PRAGMA user_version = n`. Never change a script
   * once a build that has it is out: add a new one. A script must not contain
   * `BEGIN` or `COMMIT`, and must not be empty.
   */
  migrations: string[];
  /** For tests: `memoryBackend()` from `@droid-kit/store/test`. On a device the Tauri plugin is used. */
  backend?: Backend;
  /** For tests: the clock the record helpers stamp times with (milliseconds since 1970). */
  now?: () => number;
}

export interface Store {
  /** The name given to `openStore`. */
  readonly name: string;
  /** The database file. */
  readonly path: string;
  /** The schema version: how many migrations have been applied. */
  readonly version: number;
  /** The SQLite library built into the app. */
  readonly sqliteVersion: string;
  /** `wal` for a database file. */
  readonly journalMode: string;
  /** This installation's identifier, made once and kept in the database (`_dk_meta`). */
  readonly deviceId: string;
  /** The clock the record helpers use, in milliseconds since 1970. */
  now(): number;
  /** Reads rows. `?` placeholders take `params`. */
  select<T = Row>(sql: string, params?: Param[]): Promise<T[]>;
  /** Runs one statement and says how many rows it changed. */
  execute(sql: string, params?: Param[]): Promise<{ rowsAffected: number }>;
  /** Runs the statements in one transaction: all of them, or none. */
  batch(statements: Statement[]): Promise<void>;
}

function pickBackend(): Backend {
  if ('__TAURI_INTERNALS__' in globalThis) return tauriBackend;
  throw new StoreError('platform', 'no storage backend: this is not a Tauri app; pass `backend` (see `@droid-kit/store/test`)');
}

/** The store's own table, outside the app's migrations. */
const META = 'CREATE TABLE IF NOT EXISTS _dk_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)';

async function deviceIdOf(backend: Backend): Promise<string> {
  await backend.execute(META, []);
  await backend.execute("INSERT OR IGNORE INTO _dk_meta (key, value) VALUES ('device_id', ?)", [newId()]);
  const rows = await backend.select("SELECT value FROM _dk_meta WHERE key = 'device_id'", []);
  return String(rows[0]?.value);
}

/**
 * Opens the app's database, creating it and applying the migrations it has not
 * had. Opening again (a page reload) is safe. Rejects with a `StoreError`; if a
 * migration fails, the database stays at its previous version.
 */
export async function openStore(options: OpenOptions): Promise<Store> {
  const backend = options.backend ?? pickBackend();
  const clock = options.now ?? Date.now;
  const info: BackendInfo = await backend.open(options.name, options.migrations);
  const deviceId = await deviceIdOf(backend);
  return {
    name: options.name,
    path: info.path,
    version: info.version,
    sqliteVersion: info.sqliteVersion,
    journalMode: info.journalMode,
    deviceId,
    now: clock,
    select: async <T = Row>(sql: string, params: Param[] = []) => (await backend.select(sql, params)) as unknown as T[],
    execute: async (sql, params = []) => ({ rowsAffected: await backend.execute(sql, params) }),
    batch: statements => backend.batch(statements),
  };
}

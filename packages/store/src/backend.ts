// What a storage backend does. The app talks to `Store`; a backend is the thing
// underneath: the Tauri plugin on a device, or `memoryBackend` from
// `@droid-kit/store/test` in unit tests.

/** What a parameter or a column value is. Booleans are stored as 0 or 1. */
export type Param = null | boolean | number | string;

/** A row, keyed by column name. SQLite integers come back as numbers. */
export type Row = Record<string, Param>;

export interface Statement {
  sql: string;
  params?: Param[];
}

export interface BackendInfo {
  /** The database file (`:memory:` for a test database). */
  path: string;
  /** The schema version: how many migrations have been applied. */
  version: number;
  /** The SQLite library behind it, such as `3.54.1`. */
  sqliteVersion: string;
  journalMode: string;
}

export interface Backend {
  open(name: string, migrations: string[]): Promise<BackendInfo>;
  select(sql: string, params: Param[]): Promise<Row[]>;
  execute(sql: string, params: Param[]): Promise<number>;
  /** All statements in one transaction, or none of them. */
  batch(statements: Statement[]): Promise<void>;
}

export type StoreErrorKind = 'sql' | 'empty' | 'invalid' | 'migration' | 'too-new' | 'not-open' | 'platform';

/** What every store call rejects with. */
export class StoreError extends Error {
  readonly kind: StoreErrorKind;
  /** For `migration`: the number of the script that failed. */
  readonly version?: number;
  constructor(kind: StoreErrorKind, message: string, version?: number) {
    super(message);
    this.name = 'StoreError';
    this.kind = kind;
    this.version = version;
  }
}

/** True for SQL with nothing in it but whitespace, semicolons and comments. */
export function isBlankSql(sql: string): boolean {
  let rest = sql;
  for (;;) {
    rest = rest.replace(/^[\s;]+/, '');
    if (rest.startsWith('--')) {
      const nl = rest.indexOf('\n');
      rest = nl < 0 ? '' : rest.slice(nl + 1);
    } else if (rest.startsWith('/*')) {
      const end = rest.indexOf('*/');
      rest = end < 0 ? '' : rest.slice(end + 2);
    } else {
      return rest.length === 0;
    }
  }
}

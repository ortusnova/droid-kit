// A backend for unit tests, without Tauri: Node's built-in SQLite (`node:sqlite`,
// the SQLite library bundled with Node itself) behind the same interface and
// with the same rules as the `droid-kit-store` crate:
//   - script n and `user_version = n` are one transaction, and a failure leaves both as they were;
//   - a batch is one transaction;
//   - empty or comment-only SQL is refused with a clear error;
//   - foreign keys are on.
// It is not exported from the package's main entry, because a browser bundle
// must not see `node:sqlite`: use `import { memoryBackend } from '@droid-kit/store/test'`.
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { StoreError, isBlankSql, type Backend, type BackendInfo, type Param, type Row, type Statement } from './backend';

export interface MemoryBackendOptions {
  /** A file to keep the data in, so a test can close and reopen it. Default: a database in memory. */
  path?: string;
}

const bind = (params: Param[]): SQLInputValue[] => params.map(p => (typeof p === 'boolean' ? (p ? 1 : 0) : p));

function failure(e: unknown): StoreError {
  return e instanceof StoreError ? e : new StoreError('sql', e instanceof Error ? e.message : String(e));
}

function notBlank(sql: string, what = '') {
  if (isBlankSql(sql)) throw new StoreError('empty', `${what}the SQL is empty or only comments; SQLite takes no statement from it`);
}

export interface MemoryBackend extends Backend {
  /** Closes the database, so a test can open the same file again. */
  close(): void;
}

export function memoryBackend(options: MemoryBackendOptions = {}): MemoryBackend {
  let db: DatabaseSync | undefined;
  const need = (): DatabaseSync => {
    if (!db) throw new StoreError('not-open', 'the store is not open; call openStore first');
    return db;
  };
  const version = (d: DatabaseSync) => Number((d.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);

  const transaction = (d: DatabaseSync, run: () => void) => {
    d.exec('BEGIN');
    try {
      run();
      d.exec('COMMIT');
    } catch (e) {
      d.exec('ROLLBACK');
      throw e;
    }
  };

  return {
    close() {
      db?.close();
      db = undefined;
    },
    async open(_name, migrations): Promise<BackendInfo> {
      if (!db) {
        db = new DatabaseSync(options.path ?? ':memory:');
        if (options.path) db.exec('PRAGMA journal_mode = WAL');
        db.exec('PRAGMA foreign_keys = ON');
      }
      const d = db;
      const current = version(d);
      if (current > migrations.length) {
        throw new StoreError('too-new', `the database is at version ${current}, but this build of the app only knows ${migrations.length} migration(s)`);
      }
      const pending = migrations.slice(current);
      pending.forEach((script, i) => {
        if (isBlankSql(script)) throw new StoreError('migration', 'migration ' + (current + i + 1) + ' failed: the script is empty or only comments', current + i + 1);
      });
      pending.forEach((script, i) => {
        const n = current + i + 1;
        try {
          transaction(d, () => {
            d.exec(script);
            d.exec(`PRAGMA user_version = ${n}`);
          });
        } catch (e) {
          throw new StoreError('migration', `migration ${n} failed: ${failure(e).message}`, n);
        }
      });
      const { v } = d.prepare('SELECT sqlite_version() AS v').get() as { v: string };
      const { journal_mode: mode } = d.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
      return { path: options.path ?? ':memory:', version: version(d), sqliteVersion: v, journalMode: mode };
    },
    async select(sql, params): Promise<Row[]> {
      notBlank(sql);
      try {
        return need()
          .prepare(sql)
          .all(...bind(params))
          .map(row => ({ ...row }) as Row);
      } catch (e) {
        throw failure(e);
      }
    },
    async execute(sql, params): Promise<number> {
      notBlank(sql);
      try {
        return Number(need().prepare(sql).run(...bind(params)).changes);
      } catch (e) {
        throw failure(e);
      }
    },
    async batch(statements: Statement[]): Promise<void> {
      const d = need();
      statements.forEach((s, i) => notBlank(s.sql, `statement ${i + 1}: `));
      let n = 0;
      try {
        transaction(d, () => {
          for (const s of statements) {
            n += 1;
            d.prepare(s.sql).run(...bind(s.params ?? []));
          }
        });
      } catch (e) {
        throw new StoreError('sql', `statement ${n}: ${failure(e).message}`);
      }
    },
  };
}

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  RECORD_COLUMNS,
  StoreError,
  deleteRecord,
  deleteStatement,
  getRecord,
  insertRecord,
  insertStatement,
  isBlankSql,
  newId,
  openStore,
  restoreRecord,
  selectRecords,
  updateRecord,
  updateStatement,
  type Store,
} from '../src';
import { memoryBackend, type MemoryBackend } from '../src/memory';

const dirs: string[] = [];
const backends: MemoryBackend[] = [];
afterEach(() => {
  for (const b of backends.splice(0)) b.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dk-store-test-'));
  dirs.push(dir);
  return join(dir, 'app.db');
}
function backend(path?: string): MemoryBackend {
  const b = memoryBackend({ path });
  backends.push(b);
  return b;
}
const names = async (s: Store) => (await s.select<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != '_dk_meta' ORDER BY name")).map(r => r.name);
const count = async (s: Store, table: string) => (await s.select<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`))[0].n;

describe('migrations', () => {
  it('apply once and in order', async () => {
    const path = tempFile();
    const m = ['CREATE TABLE a (n INTEGER)', 'ALTER TABLE a ADD COLUMN s TEXT', 'CREATE TABLE b (x TEXT)'];
    const first = await openStore({ name: 'app', migrations: m.slice(0, 2), backend: backend(path) });
    expect(first.version).toBe(2);
    await first.execute('INSERT INTO a (n, s) VALUES (?, ?)', [1, 'kept']);
    // Opening the same two again applies nothing (a second ALTER would fail) and keeps the data.
    const again = await openStore({ name: 'app', migrations: m.slice(0, 2), backend: backend(path) });
    expect(again.version).toBe(2);
    expect(await count(again, 'a')).toBe(1);
    // A build with three applies only the third.
    const third = await openStore({ name: 'app', migrations: m, backend: backend(path) });
    expect(third.version).toBe(3);
    expect(await names(third)).toEqual(['a', 'b']);
    expect(await third.select('SELECT s FROM a')).toEqual([{ s: 'kept' }]);
  });

  it('leave the version and the data unchanged when one fails', async () => {
    const path = tempFile();
    const good = ['CREATE TABLE a (n INTEGER); INSERT INTO a VALUES (1)'];
    await openStore({ name: 'app', migrations: good, backend: backend(path) });
    const bad = [...good, 'CREATE TABLE half (x); INSERT INTO nope VALUES (1)'];
    const error = await openStore({ name: 'app', migrations: bad, backend: backend(path) }).catch(e => e);
    expect(error).toBeInstanceOf(StoreError);
    expect(error).toMatchObject({ kind: 'migration', version: 2 });
    expect(error.message).toContain('nope');
    const after = await openStore({ name: 'app', migrations: good, backend: backend(path) });
    expect(after.version).toBe(1);
    expect(await names(after)).toEqual(['a']);
    expect(await count(after, 'a')).toBe(1);
  });

  it('refuse an empty or comment-only script clearly, before anything runs', async () => {
    for (const blank of ['', '  \n', '-- nothing', '/* nothing */;']) {
      expect(isBlankSql(blank)).toBe(true);
      await expect(openStore({ name: 'app', migrations: ['CREATE TABLE a (n)', blank], backend: backend() })).rejects.toMatchObject({ kind: 'migration', version: 2, message: expect.stringContaining('empty') });
    }
    const path = tempFile();
    await expect(openStore({ name: 'app', migrations: ['CREATE TABLE a (n)', '-- later'], backend: backend(path) })).rejects.toBeInstanceOf(StoreError);
    expect((await openStore({ name: 'app', migrations: [], backend: backend(path) })).version).toBe(0);
    expect(isBlankSql('-- c\nSELECT 1')).toBe(false);
  });

  it('refuse a database from a newer build', async () => {
    const path = tempFile();
    await openStore({ name: 'app', migrations: ['CREATE TABLE a (n)', 'CREATE TABLE b (n)'], backend: backend(path) });
    await expect(openStore({ name: 'app', migrations: ['CREATE TABLE a (n)'], backend: backend(path) })).rejects.toMatchObject({ kind: 'too-new' });
  });
});

describe('batches', () => {
  it('store nothing when one statement fails', async () => {
    const s = await openStore({ name: 'app', migrations: ['CREATE TABLE a (id INTEGER PRIMARY KEY, n INTEGER NOT NULL)'], backend: backend() });
    await s.batch([{ sql: 'INSERT INTO a (id, n) VALUES (1, 1)' }]);
    const error = await s
      .batch([
        { sql: 'INSERT INTO a (id, n) VALUES (?, ?)', params: [2, 2] },
        { sql: 'INSERT INTO a (id, n) VALUES (3, NULL)' },
        { sql: 'INSERT INTO a (id, n) VALUES (4, 4)' },
      ])
      .catch(e => e);
    expect(error).toMatchObject({ kind: 'sql', message: expect.stringContaining('statement 2') });
    expect(await s.select('SELECT id FROM a ORDER BY id')).toEqual([{ id: 1 }]);
    // 20 times in a row, and the connection is still fine afterwards.
    for (let i = 0; i < 20; i++) {
      await expect(s.batch([{ sql: 'INSERT INTO a (id, n) VALUES (?, 1)', params: [100 + i] }, { sql: 'INSERT INTO nope VALUES (1)' }])).rejects.toBeInstanceOf(StoreError);
      await s.batch([{ sql: 'INSERT INTO a (id, n) VALUES (?, 1)', params: [200 + i] }]);
    }
    expect(await count(s, 'a')).toBe(21);
    expect(await s.select('SELECT id FROM a WHERE id >= 100 AND id < 200')).toEqual([]);
  });

  it('refuse an empty statement, naming it, and run nothing', async () => {
    const s = await openStore({ name: 'app', migrations: ['CREATE TABLE a (n)'], backend: backend() });
    await expect(s.batch([{ sql: 'INSERT INTO a VALUES (1)' }, { sql: '  ' }])).rejects.toMatchObject({ kind: 'empty', message: expect.stringContaining('statement 2') });
    expect(await count(s, 'a')).toBe(0);
    await expect(s.select('')).rejects.toMatchObject({ kind: 'empty' });
    await expect(s.execute('-- x')).rejects.toMatchObject({ kind: 'empty' });
  });

  it('write params and read rows as JSON values', async () => {
    const s = await openStore({ name: 'app', migrations: ['CREATE TABLE t (i INTEGER, r REAL, s TEXT, b INTEGER, n TEXT)'], backend: backend() });
    expect((await s.execute('INSERT INTO t (i, r, s, b, n) VALUES (?, ?, ?, ?, ?)', [1_795_000_000_000, 1.5, 'héllo "q"', true, null])).rowsAffected).toBe(1);
    expect(await s.select('SELECT * FROM t')).toEqual([{ i: 1_795_000_000_000, r: 1.5, s: 'héllo "q"', b: 1, n: null }]);
  });
});

describe('the device id', () => {
  it('is made once, kept across opens, and is its own table', async () => {
    const path = tempFile();
    const a = await openStore({ name: 'app', migrations: ['CREATE TABLE a (n)'], backend: backend(path) });
    expect(a.deviceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const b = await openStore({ name: 'app', migrations: ['CREATE TABLE a (n)'], backend: backend(path) });
    expect(b.deviceId).toBe(a.deviceId);
    // Another installation (another file) has another id, and the app's migrations did not make `_dk_meta`.
    const other = await openStore({ name: 'app', migrations: [], backend: backend() });
    expect(other.deviceId).not.toBe(a.deviceId);
    expect(await names(a)).toEqual(['a']);
    expect(await a.select('SELECT key FROM _dk_meta')).toEqual([{ key: 'device_id' }]);
  });
});

describe('newId', () => {
  it('is a UUIDv7 that sorts by creation order', () => {
    const ids = Array.from({ length: 2000 }, () => newId());
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('records', () => {
  async function open(now: () => number) {
    return openStore({ name: 'app', migrations: [`CREATE TABLE habit (${RECORD_COLUMNS}, name TEXT NOT NULL, rank REAL)`], backend: backend(), now });
  }

  it('stamp an id, the times and the device id on insert', async () => {
    let t = 1_000;
    const s = await open(() => t);
    const h = await insertRecord(s, 'habit', { name: 'Morning run', rank: 1 });
    expect(h).toMatchObject({ name: 'Morning run', rank: 1, created_at: 1_000, updated_at: 1_000, device_id: s.deviceId, deleted_at: null });
    expect(h.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await getRecord(s, 'habit', h.id)).toEqual(h);
    t = 2_000;
    const g = await insertRecord(s, 'habit', { name: 'Stretch', rank: 2 });
    expect(g.id > h.id).toBe(true);
  });

  it('keep the id and creation time on update, and move the change time and device id', async () => {
    let t = 1_000;
    const s = await open(() => t);
    const h = await insertRecord(s, 'habit', { name: 'Run', rank: 1 });
    t = 5_000;
    expect(await updateRecord(s, 'habit', h.id, { name: 'Morning run' })).toBe(true);
    const after = (await getRecord<typeof h>(s, 'habit', h.id))!;
    expect(after).toMatchObject({ id: h.id, created_at: 1_000, updated_at: 5_000, name: 'Morning run', rank: 1, device_id: s.deviceId });
    // The same millisecond: still later than before.
    expect(await updateRecord(s, 'habit', h.id, { rank: 3 })).toBe(true);
    expect((await getRecord<typeof h>(s, 'habit', h.id))!.updated_at).toBe(5_001);
    // A clock that went backwards must not make a change earlier.
    t = 10;
    await updateRecord(s, 'habit', h.id, { rank: 4 });
    expect((await getRecord<typeof h>(s, 'habit', h.id))!.updated_at).toBe(5_002);
    expect(await updateRecord(s, 'habit', 'no-such-id', { rank: 1 })).toBe(false);
  });

  it('leave a tombstone on delete: reads skip it, the row stays with its deletion time', async () => {
    let t = 1_000;
    const s = await open(() => t);
    const keep = await insertRecord(s, 'habit', { name: 'Keep', rank: 1 });
    const gone = await insertRecord(s, 'habit', { name: 'Gone', rank: 2 });
    t = 7_000;
    expect(await deleteRecord(s, 'habit', gone.id)).toBe(true);
    expect(await deleteRecord(s, 'habit', gone.id)).toBe(false);
    expect((await selectRecords<{ id: string }>(s, 'habit')).map(r => r.id)).toEqual([keep.id]);
    expect(await getRecord(s, 'habit', gone.id)).toBeUndefined();
    const raw = await s.select<{ id: string; deleted_at: number; updated_at: number }>('SELECT * FROM habit WHERE id = ?', [gone.id]);
    expect(raw).toHaveLength(1);
    expect(raw[0]).toMatchObject({ deleted_at: 7_000, updated_at: 7_000 });
    expect((await selectRecords<{ id: string }>(s, 'habit', { includeDeleted: true })).map(r => r.id)).toEqual([keep.id, gone.id]);
    // A deleted record cannot be updated, but it can be brought back.
    expect(await updateRecord(s, 'habit', gone.id, { name: 'x' })).toBe(false);
    t = 8_000;
    expect(await restoreRecord(s, 'habit', gone.id)).toBe(true);
    expect(await getRecord(s, 'habit', gone.id)).toMatchObject({ name: 'Gone', deleted_at: null, updated_at: 8_000 });
  });

  it('filter and order reads, always without deleted records', async () => {
    const s = await open(() => 1);
    for (const [name, rank] of [['c', 3], ['a', 1], ['b', 2]] as const) await insertRecord(s, 'habit', { name, rank });
    const rows = await selectRecords<{ name: string }>(s, 'habit', { where: 'rank >= ? OR name = ?', params: [2, 'a'], orderBy: 'rank DESC' });
    expect(rows.map(r => r.name)).toEqual(['c', 'b', 'a']);
  });

  it('work as statements in one batch, which stores all or none', async () => {
    const s = await open(() => 1);
    const a = insertStatement(s, 'habit', { name: 'A', rank: 1 });
    const b = insertStatement(s, 'habit', { name: 'B', rank: 2 });
    await s.batch([a.statement, b.statement, updateStatement(s, 'habit', a.record.id, { name: 'A2' }), deleteStatement(s, 'habit', b.record.id)]);
    expect((await selectRecords<{ name: string }>(s, 'habit')).map(r => r.name)).toEqual(['A2']);
    // The second insert breaks NOT NULL: neither is stored.
    const c = insertStatement(s, 'habit', { name: 'C', rank: 3 });
    await expect(s.batch([c.statement, { sql: 'INSERT INTO habit (id, created_at, updated_at, device_id, name) VALUES (?, 1, 1, ?, NULL)', params: ['x', s.deviceId] }])).rejects.toBeInstanceOf(StoreError);
    expect(await getRecord(s, 'habit', c.record.id)).toBeUndefined();
  });

  it('refuse reserved columns and odd names', async () => {
    const s = await open(() => 1);
    await expect(insertRecord(s, 'habit', { name: 'x', updated_at: 5 })).rejects.toThrow(/set by the store/);
    const h = await insertRecord(s, 'habit', { name: 'x' });
    await expect(updateRecord(s, 'habit', h.id, { deleted_at: null })).rejects.toThrow(/set by the store/);
    await expect(insertRecord(s, 'habit; DROP TABLE habit', { name: 'x' })).rejects.toThrow(/not a table or column name/);
    await expect(insertRecord(s, 'habit', { 'name) VALUES (1); --': 'x' })).rejects.toThrow(/not a table or column name/);
  });
});

describe('without a backend', () => {
  it('says so when this is not a Tauri app', async () => {
    await expect(openStore({ name: 'app', migrations: [] })).rejects.toMatchObject({ kind: 'platform' });
  });
});

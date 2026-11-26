// Record conventions, so that two devices can be merged row by row later.
//
// A table made for records has the columns in `RECORD_COLUMNS`:
//   id          a UUIDv7, so ids sort by creation time
//   created_at  milliseconds since 1970, UTC
//   updated_at  the same, when the record last changed
//   device_id   the installation that last changed it
//   deleted_at  null, or when it was deleted: a deletion leaves the row behind
//
// The helpers stamp them. Reads through `selectRecords` and `getRecord` leave
// deleted rows out. Each write has a `…Statement` form for use in `store.batch`.
import type { Param, Row, Statement } from './backend';
import { newId, type Store } from './index';

/** The columns every record table has, to put first in `CREATE TABLE`. */
export const RECORD_COLUMNS = 'id TEXT PRIMARY KEY NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, device_id TEXT NOT NULL, deleted_at INTEGER';

export interface RecordFields {
  id: string;
  created_at: number;
  updated_at: number;
  device_id: string;
  deleted_at: number | null;
}

const RESERVED = ['id', 'created_at', 'updated_at', 'device_id', 'deleted_at'];

function ident(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`"${name}" is not a table or column name`);
  return name;
}

function fields(values: Record<string, Param>, what: string): [string[], Param[]] {
  const names = Object.keys(values).map(ident);
  const clash = names.find(n => RESERVED.includes(n));
  if (clash) throw new Error(`${what}: "${clash}" is set by the store`);
  return [names, names.map(n => values[n])];
}

/** An insert: the record that will be stored, and the statement that stores it. */
export function insertStatement<T extends Record<string, Param>>(store: Store, table: string, values: T): { record: T & RecordFields; statement: Statement } {
  const [names, params] = fields(values, 'insertRecord');
  const now = store.now();
  const record = { ...values, id: newId(), created_at: now, updated_at: now, device_id: store.deviceId, deleted_at: null } as T & RecordFields;
  const columns = ['id', 'created_at', 'updated_at', 'device_id', ...names];
  const marks = columns.map(() => '?').join(', ');
  return { record, statement: { sql: `INSERT INTO ${ident(table)} (${columns.join(', ')}) VALUES (${marks})`, params: [record.id, now, now, store.deviceId, ...params] } };
}

/**
 * An update of the given columns. `updated_at` is the later of now and one
 * millisecond after the old value, so a change is always later than the
 * record before it.
 */
export function updateStatement(store: Store, table: string, id: string, changes: Record<string, Param>): Statement {
  const [names, params] = fields(changes, 'updateRecord');
  const sets = names.map(n => `${n} = ?`);
  return {
    sql: `UPDATE ${ident(table)} SET ${[...sets, 'updated_at = MAX(?, updated_at + 1)', 'device_id = ?'].join(', ')} WHERE id = ? AND deleted_at IS NULL`,
    params: [...params, store.now(), store.deviceId, id],
  };
}

/** A deletion: the row stays, with `deleted_at` set. */
export function deleteStatement(store: Store, table: string, id: string): Statement {
  const now = store.now();
  return { sql: `UPDATE ${ident(table)} SET deleted_at = ?, updated_at = MAX(?, updated_at + 1), device_id = ? WHERE id = ? AND deleted_at IS NULL`, params: [now, now, store.deviceId, id] };
}

/** Brings a deleted record back (an undo that is then done again, say). */
export function restoreStatement(store: Store, table: string, id: string): Statement {
  return { sql: `UPDATE ${ident(table)} SET deleted_at = NULL, updated_at = MAX(?, updated_at + 1), device_id = ? WHERE id = ? AND deleted_at IS NOT NULL`, params: [store.now(), store.deviceId, id] };
}

/** Stores a new record and returns it, with its id and stamps. */
export async function insertRecord<T extends Record<string, Param>>(store: Store, table: string, values: T): Promise<T & RecordFields> {
  const { record, statement } = insertStatement(store, table, values);
  await store.execute(statement.sql, statement.params);
  return record;
}

/** Changes columns of a record that is not deleted. Resolves to false if there is no such record. */
export async function updateRecord(store: Store, table: string, id: string, changes: Record<string, Param>): Promise<boolean> {
  const s = updateStatement(store, table, id, changes);
  return (await store.execute(s.sql, s.params)).rowsAffected === 1;
}

/** Marks a record deleted. Resolves to false if there is no such live record. */
export async function deleteRecord(store: Store, table: string, id: string): Promise<boolean> {
  const s = deleteStatement(store, table, id);
  return (await store.execute(s.sql, s.params)).rowsAffected === 1;
}

/** Undoes `deleteRecord`. Resolves to false if the record is not deleted. */
export async function restoreRecord(store: Store, table: string, id: string): Promise<boolean> {
  const s = restoreStatement(store, table, id);
  return (await store.execute(s.sql, s.params)).rowsAffected === 1;
}

export interface SelectRecordsOptions {
  /** SQL for a `WHERE` clause, such as `habit_id = ? AND day >= ?`. It is combined with `deleted_at IS NULL`. */
  where?: string;
  params?: Param[];
  /** SQL for an `ORDER BY` clause, such as `rank, created_at`. Ids sort by creation time. */
  orderBy?: string;
  /** Also return deleted records. */
  includeDeleted?: boolean;
}

/** Reads records of a table, leaving out deleted ones unless asked. */
export function selectRecords<T = Row & RecordFields>(store: Store, table: string, options: SelectRecordsOptions = {}): Promise<T[]> {
  const conditions = [options.includeDeleted ? '' : 'deleted_at IS NULL', options.where ? `(${options.where})` : ''].filter(Boolean);
  const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
  const order = options.orderBy ? ` ORDER BY ${options.orderBy}` : '';
  return store.select<T>(`SELECT * FROM ${ident(table)}${where}${order}`, options.params ?? []);
}

/** One record by id, or undefined if there is none or it is deleted. */
export async function getRecord<T = Row & RecordFields>(store: Store, table: string, id: string): Promise<T | undefined> {
  return (await selectRecords<T>(store, table, { where: 'id = ?', params: [id] }))[0];
}

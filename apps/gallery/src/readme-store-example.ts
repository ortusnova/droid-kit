import { RECORD_COLUMNS, deleteRecord, insertRecord, insertStatement, openStore, selectRecords, updateStatement, type RecordFields } from '@droid-kit/store';

// Script n runs once, together with `PRAGMA user_version = n`. Add to the end; never edit a shipped one.
const migrations = [
  `CREATE TABLE habit (${RECORD_COLUMNS}, name TEXT NOT NULL, rank REAL NOT NULL)`,
  `CREATE TABLE outcome (${RECORD_COLUMNS}, habit_id TEXT NOT NULL REFERENCES habit(id), day TEXT NOT NULL, kind TEXT NOT NULL)`,
];

type Habit = RecordFields & { name: string; rank: number };

export async function example() {
  const store = await openStore({ name: 'life', migrations });

  // A record: the store adds id, created_at, updated_at and device_id.
  const run = await insertRecord(store, 'habit', { name: 'Morning run', rank: 1 });

  // A batch is one transaction: both statements are stored, or neither is.
  const done = insertStatement(store, 'outcome', { habit_id: run.id, day: '2026-11-26', kind: 'done' });
  await store.batch([done.statement, updateStatement(store, 'habit', run.id, { rank: 2 })]);

  // Reads leave out deleted records; a deletion keeps the row with deleted_at set.
  const habits = await selectRecords<Habit>(store, 'habit', { orderBy: 'rank' });
  await deleteRecord(store, 'habit', run.id);
  return habits;
}

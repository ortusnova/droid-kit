// The app's local database (`@droid-kit/store`). Nothing opens it until the
// app calls `store()`.
//
// Add scripts to the end of `migrations`; never change one that has shipped,
// because script n runs once, on the devices that have not had it yet. A table
// made for records starts with the sync columns: `CREATE TABLE note (${RECORD_COLUMNS}, text TEXT)`,
// with `RECORD_COLUMNS` from '@droid-kit/store'.
import { openStore, type Store } from '@droid-kit/store';

export const migrations: string[] = [];

let opened: Promise<Store> | undefined;

/** The open database. The first call opens it and applies the migrations. */
export function store(): Promise<Store> {
  opened ??= openStore({ name: 'app', migrations });
  return opened;
}

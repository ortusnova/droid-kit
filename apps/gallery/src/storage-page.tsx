// Storage: the app's database (`@droid-kit/store`). Add a note, delete the
// newest one, and see where the file is and which SQLite is inside.
import { useCallback, useEffect, useState } from 'react';
import { dk } from '@droid-kit/platform';
import { RECORD_COLUMNS, StoreError, deleteRecord, insertRecord, openStore, selectRecords, type RecordFields, type Store } from '@droid-kit/store';
import { Button, Card, List, ListRow } from '@droid-kit/ui';

// Two scripts, so opening an older file exercises a migration: script 1 makes
// the table, script 2 adds a column.
const MIGRATIONS = [`CREATE TABLE note (${RECORD_COLUMNS}, text TEXT NOT NULL)`, 'ALTER TABLE note ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0'];

type Note = RecordFields & { text: string; pinned: number };

const clock = () => new Date().toTimeString().slice(0, 8);

export function StoragePage() {
  const [store, setStore] = useState<Store | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [deleted, setDeleted] = useState(0);
  const [error, setError] = useState('');

  const refresh = useCallback(async (s: Store) => {
    setNotes(await selectRecords<Note>(s, 'note', { orderBy: 'id DESC' }));
    const all = await s.select<{ n: number }>('SELECT COUNT(*) AS n FROM note WHERE deleted_at IS NOT NULL');
    setDeleted(all[0].n);
  }, []);

  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in globalThis)) {
      setError('not in the app: there is no database here');
      return;
    }
    let live = true;
    void (async () => {
      try {
        const s = await openStore({ name: 'gallery', migrations: MIGRATIONS });
        if (!live) return;
        // Debug builds: `dk run linux-desktop --route '/storage?note=text'` writes a note on start, for checks that cannot press a button.
        const text = dk().debug ? /[?&]note=([^&]+)/.exec(window.__DK__?.startRoute ?? '')?.[1] : undefined;
        if (text) await insertRecord(s, 'note', { text: decodeURIComponent(text), pinned: 0 });
        setStore(s);
        await refresh(s);
      } catch (e) {
        setError(e instanceof StoreError ? `${e.kind}: ${e.message}` : String(e));
      }
    })();
    return () => {
      live = false;
    };
  }, [refresh]);

  const add = async () => {
    if (!store) return;
    await insertRecord(store, 'note', { text: `note at ${clock()}`, pinned: 0 });
    await refresh(store);
  };
  const removeNewest = async () => {
    if (!store || !notes[0]) return;
    await deleteRecord(store, 'note', notes[0].id);
    await refresh(store);
  };

  return (
    <div className="flex flex-col gap-4 p-4" id="storage-page">
      <Card title="Database">
        {error ? (
          <p className="text-small" id="storage-error">{error}</p>
        ) : (
          <dl className="text-small flex flex-col gap-1" id="storage-facts">
            <Fact name="file" value={store?.path} />
            <Fact name="SQLite" value={store?.sqliteVersion} />
            <Fact name="journal" value={store?.journalMode} />
            <Fact name="schema version" value={store?.version} />
            <Fact name="device id" value={store?.deviceId} />
          </dl>
        )}
        <div className="flex flex-wrap gap-2">
          <Button id="note-add" variant="primary" onPress={() => void add()} isDisabled={!store}>
            Add a note
          </Button>
          <Button id="note-delete" onPress={() => void removeNewest()} isDisabled={!store || notes.length === 0}>
            Delete the newest
          </Button>
        </div>
      </Card>
      <List title={`Notes: ${notes.length} (${deleted} deleted)`}>
        {notes.length === 0 ? <ListRow title="No notes yet" /> : notes.map(n => <ListRow key={n.id} title={n.text} subtitle={`${n.id.slice(0, 13)}… · by ${n.device_id.slice(-6)} · ${new Date(n.created_at).toLocaleTimeString()}`} data-note={n.text} />)}
      </List>
    </div>
  );
}

function Fact({ name, value }: { name: string; value: string | number | undefined }) {
  return (
    <div>
      <dt className="text-muted">{name}</dt>
      <dd className="break-all" data-fact={name}>{value ?? '…'}</dd>
    </div>
  );
}

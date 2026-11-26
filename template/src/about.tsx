import { useEffect, useState } from 'react';
import { VERSION } from '@droid-kit/ui';
import { dk } from '@droid-kit/platform';
import { List, ListRow } from '@droid-kit/ui';
import { APP } from './app-info';
import { store } from './store';

type Database = { sqlite: string; path: string; journal: string; version: number } | { error: string };

export function AboutPage() {
  const d = dk();
  // Opening the database here shows that it works on this device (the template's device scenario checks it).
  const [db, setDb] = useState<Database | null>(null);
  useEffect(() => {
    store().then(
      s => setDb({ sqlite: s.sqliteVersion, path: s.path, journal: s.journalMode, version: s.version }),
      e => setDb({ error: e instanceof Error ? e.message : String(e) }),
    );
  }, []);
  return (
    <div className="flex flex-col gap-4 p-4">
      <List>
        <ListRow title="App" subtitle={APP.name} />
        <ListRow title="Identifier" subtitle={APP.identifier} />
        <ListRow title="droid-kit" subtitle={`v${VERSION}`} />
        <ListRow title="Platform" subtitle={`${d.platform}, ${d.formFactor}, ${d.engine.name} ${d.engine.version ?? ''}`} />
        <ListRow
          data-database={db === null ? 'opening' : 'error' in db ? 'error' : 'open'}
          title="Database"
          subtitle={db === null ? 'Opening…' : 'error' in db ? db.error : `SQLite ${db.sqlite}, ${db.journal}, schema ${db.version}: ${db.path}`}
        />
      </List>
    </div>
  );
}

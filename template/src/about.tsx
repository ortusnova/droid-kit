import { VERSION } from '@droid-kit/ui';
import { dk } from '@droid-kit/platform';
import { List, ListRow } from '@droid-kit/ui';
import { APP } from './app-info';

export function AboutPage() {
  const d = dk();
  return (
    <div className="flex flex-col gap-4 p-4">
      <List>
        <ListRow title="App" subtitle={APP.name} />
        <ListRow title="Identifier" subtitle={APP.identifier} />
        <ListRow title="droid-kit" subtitle={`v${VERSION}`} />
        <ListRow title="Platform" subtitle={`${d.platform}, ${d.formFactor}, ${d.engine.name} ${d.engine.version ?? ''}`} />
      </List>
    </div>
  );
}

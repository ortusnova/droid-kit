import { Inbox } from 'lucide-react';
import { EmptyState, List, ListRow } from '@droid-kit/ui';

// The app bar above shows the app's title (src/main.tsx). Replace this screen with your own.
export function HomePage() {
  return (
    <div className="flex flex-col gap-4 p-4">
      <EmptyState
        icon={<Inbox size={40} />}
        title="Nothing here yet"
        body="This is the start screen of a new droid-kit app."
      />
      <List>
        <ListRow title="About this app" href="/about" />
      </List>
    </div>
  );
}

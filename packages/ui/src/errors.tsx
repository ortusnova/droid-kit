import { useEffect } from 'react';
import { TriangleAlert } from 'lucide-react';
import { reportError } from '@droid-kit/platform';
import { Button } from './controls';
import { EmptyState } from './content';

const reported = new WeakSet<object>();

/**
 * The screen to show when a route fails to render, and the report of the
 * failure: `DK_ERROR render error: …` in the app's log, which makes `dk run`
 * fail and name it. Give it to the router, which catches render errors itself:
 *
 *     createRouter({ routeTree, defaultErrorComponent: RouteError })
 *
 * TanStack Router passes `error` and `reset`.
 */
export function RouteError({ error, reset }: { error: unknown; reset?: () => void }) {
  const message = error instanceof Error ? error.message : String(error);
  useEffect(() => {
    // The same error is reported once, though strict mode runs effects twice.
    if (typeof error === 'object' && error !== null) {
      if (reported.has(error)) return;
      reported.add(error);
    }
    const stack = error instanceof Error && error.stack ? error.stack.split('\n').slice(0, 4).join('\n') : '';
    reportError(`render error: ${message}${stack ? `\n${stack}` : ''}`);
  }, [error, message]);
  return (
    <div role="alert" data-render-error>
      <EmptyState
        icon={<TriangleAlert size={40} />}
        title="Something went wrong"
        body={message}
        action={reset && <Button onPress={reset}>Try again</Button>}
      />
    </div>
  );
}

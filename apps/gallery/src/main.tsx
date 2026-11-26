import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Outlet,
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter,
  useMatches,
  useParams,
  useRouter,
} from '@tanstack/react-router';
import { RouterProvider as AriaRouterProvider } from 'react-aria-components';
import { Blocks, Palette, Smartphone } from 'lucide-react';
import { applyStartRoute, installBackHandler, reportErrors, signalReady, syncSystemBars } from '@droid-kit/platform';
import { AppBar, AppShell, List, ListRow, TabBar, ToastRegion } from '@droid-kit/ui';
import './app.css';
import { PlatformPage } from './platform-page';
import { DesignPage } from './design-page';
import { ENTRIES } from './components-registry';

type Search = { sheet?: string };

// Tabs are routes; a component's page is a nested route; an open sheet is a
// search parameter. Each is a history entry, so the back action closes the
// sheet, then leaves the page, then goes back through the tabs.
const rootRoute = createRootRoute({
  validateSearch: (s: Record<string, unknown>): Search => (typeof s.sheet === 'string' ? { sheet: s.sheet } : {}),
  component: Shell,
});
const platformRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: PlatformPage, staticData: { title: 'Platform', tab: 'platform' } });
const designRoute = createRoute({ getParentRoute: () => rootRoute, path: '/design', component: DesignPage, staticData: { title: 'Design', tab: 'design' } });
const componentsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/components', component: ComponentsPage, staticData: { title: 'Components', tab: 'components' } });
const componentRoute = createRoute({ getParentRoute: () => rootRoute, path: '/components/$name', component: ComponentPage, staticData: { tab: 'components', nested: true } });

declare module '@tanstack/react-router' {
  interface StaticDataRouteOption {
    title?: string;
    tab?: string;
    nested?: boolean;
  }
  interface Register {
    router: typeof router;
  }
}

applyStartRoute();

const router = createRouter({
  routeTree: rootRoute.addChildren([platformRoute, designRoute, componentsRoute, componentRoute]),
  scrollRestoration: true,
  // One scroll position per screen, whatever sheet is open over it.
  getScrollRestorationKey: location => location.pathname,
  scrollToTopSelectors: ['[data-scroll-restoration-id="main"]'],
});

const TABS = [
  { id: 'platform', label: 'Platform', href: '/', icon: <Smartphone size={20} /> },
  { id: 'design', label: 'Design', href: '/design', icon: <Palette size={20} /> },
  { id: 'components', label: 'Components', href: '/components', icon: <Blocks size={20} /> },
];

/** The app bar's back: back in history, or up to the parent screen when the app started on this one. */
function goUp(r: ReturnType<typeof useRouter>, pathname: string) {
  if (r.history.canGoBack()) r.history.back();
  else void r.navigate({ to: pathname.replace(/\/[^/]+\/?$/, '') || '/', replace: true });
}

function Shell() {
  const matches = useMatches();
  const leaf = matches[matches.length - 1];
  const r = useRouter();
  const params = leaf?.params as { name?: string } | undefined;
  const entry = params?.name ? ENTRIES.find(e => e.name === params.name) : undefined;
  const title = entry?.title ?? leaf?.staticData.title ?? '';
  useEffect(signalReady, []);

  return (
    <AriaRouterProvider navigate={to => r.navigate({ to })} useHref={to => r.buildLocation({ to }).href}>
      <AppShell
        appBar={<AppBar title={title} onBack={leaf?.staticData.nested ? () => goUp(r, leaf.pathname) : undefined} />}
        tabBar={<TabBar tabs={TABS} active={leaf?.staticData.tab ?? 'platform'} />}
      >
        <Outlet />
      </AppShell>
      <ToastRegion />
    </AriaRouterProvider>
  );
}

function ComponentsPage() {
  const groups = [...new Set(ENTRIES.map(e => e.group))];
  return (
    <div className="flex flex-col gap-4 p-4">
      {groups.map(g => (
        <List key={g} title={g}>
          {ENTRIES.filter(e => e.group === g).map(e => (
            <ListRow key={e.name} title={e.title} href={`/components/${e.name}`} />
          ))}
        </List>
      ))}
    </div>
  );
}

function ComponentPage() {
  const { name } = useParams({ strict: false }) as { name: string };
  const entry = ENTRIES.find(e => e.name === name);
  if (!entry) return <p className="p-4">No component called {name}.</p>;
  return (
    <div className="flex flex-col gap-4 p-4" data-component={entry.name}>
      <ul className="text-small text-muted list-disc pl-5">
        {entry.docs.map(d => (
          <li key={d}>{d}</li>
        ))}
      </ul>
      {entry.live && <section className="flex flex-col gap-2" data-live>{entry.live()}</section>}
      {(['light', 'dark'] as const).map(mode => (
        <section key={mode} data-theme={mode} className="bg-background text-base-content rounded-box border-divider flex flex-col gap-2 border p-3" data-demo={mode}>
          <h2 className="text-caption text-muted font-semibold tracking-wide uppercase">{mode}</h2>
          {entry.demo()}
        </section>
      ))}
    </div>
  );
}

reportErrors();
syncSystemBars();
void installBackHandler();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);

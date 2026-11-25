import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Link,
  Outlet,
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter,
  useMatches,
  useNavigate,
  useRouter,
  useSearch,
} from '@tanstack/react-router';
import { applyStartRoute, installBackHandler, reportErrors, signalReady, syncSystemBars } from '@droid-kit/platform';
import '@droid-kit/platform/platform.css';
import { PlatformPage, button } from './platform-page';

type Search = { sheet?: string };

// Tabs are routes; a sub-screen is a nested route; an open sheet is a search
// parameter. Each is a history entry, so the back action closes the sheet,
// then leaves the sub-screen, then goes back through the tabs.
const rootRoute = createRootRoute({
  validateSearch: (s: Record<string, unknown>): Search => (typeof s.sheet === 'string' ? { sheet: s.sheet } : {}),
  component: Shell,
});
const platformRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: PlatformPage, staticData: { title: 'Platform', tab: true } });
const componentsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/components', component: ComponentsPage, staticData: { title: 'Components', tab: true } });
const demoRoute = createRoute({ getParentRoute: () => rootRoute, path: '/components/demo', component: DemoPage, staticData: { title: 'Sub-screen', tab: false } });

declare module '@tanstack/react-router' {
  interface StaticDataRouteOption {
    title?: string;
    tab?: boolean;
  }
  interface Register {
    router: typeof router;
  }
}

applyStartRoute();

const router = createRouter({
  routeTree: rootRoute.addChildren([platformRoute, componentsRoute, demoRoute]),
  scrollRestoration: true,
  // One scroll position per screen, whatever sheet is open over it.
  getScrollRestorationKey: location => location.pathname,
});

const TABS = [
  { to: '/', label: 'Platform' },
  { to: '/components', label: 'Components' },
] as const;

function Shell() {
  const matches = useMatches();
  const leaf = matches[matches.length - 1];
  const isTabRoot = leaf?.staticData.tab ?? true;
  const r = useRouter();
  useEffect(signalReady, []);

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', fontSize: 14, height: '100dvh', display: 'flex', flexDirection: 'column' }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 16px', paddingTop: 'calc(8px + var(--dk-inset-top))', borderBottom: '1px solid #e4e4e7' }}>
        {!isTabRoot && (
          <button style={{ ...button, margin: 0 }} aria-label="Back" onClick={() => r.history.back()}>
            ←
          </button>
        )}
        <h1 style={{ fontSize: 20, margin: 0 }} id="screen-title">{leaf?.staticData.title}</h1>
      </header>
      <main data-scroll-restoration-id="main" style={{ flex: 1, overflowY: 'auto' }}>
        <Outlet />
      </main>
      <nav
        id="tab-bar"
        style={{ display: 'flex', justifyContent: 'space-around', borderTop: '1px solid #e4e4e7', paddingBottom: 'var(--dk-inset-bottom)', background: '#155dfc' }}
      >
        {TABS.map(t => (
          <Link key={t.to} to={t.to} style={{ ...button, margin: 0, flex: 1, maxWidth: 160, display: 'grid', placeItems: 'center', color: '#fff' }} activeProps={{ style: { fontWeight: 700, textDecoration: 'underline' } }} activeOptions={{ exact: true, includeSearch: false }}>
            {t.label}
          </Link>
        ))}
      </nav>
      <Sheet />
    </div>
  );
}

function ComponentsPage() {
  return (
    <div style={{ padding: 24 }}>
      <p>Components come in task group 5. This tab shows the navigation model.</p>
      <Link to="/components/demo" id="open-demo" style={{ ...button, display: 'inline-grid', placeItems: 'center' }}>
        Open a sub-screen
      </Link>
      {Array.from({ length: 40 }, (_, i) => (
        <p key={i}>Row {i + 1}</p>
      ))}
    </div>
  );
}

function DemoPage() {
  const navigate = useNavigate();
  return (
    <div style={{ padding: 24 }}>
      <p>A screen below a tab's root. On Linux the back button in the bar above is the only way back.</p>
      <button id="open-sheet" style={button} onClick={() => navigate({ to: '.', search: { sheet: 'demo' } })}>
        Open a sheet
      </button>
    </div>
  );
}

// Stand-in for the kit's bottom sheet (task 5.3): open while ?sheet= is set.
function Sheet() {
  const { sheet } = useSearch({ strict: false }) as Search;
  const r = useRouter();
  if (!sheet) return null;
  return (
    <div role="dialog" aria-label="Demo sheet" id="sheet" style={{ position: 'fixed', inset: 0, background: 'rgb(0 0 0 / 0.4)', display: 'flex', alignItems: 'flex-end' }} onClick={() => r.history.back()}>
      <div style={{ background: '#fff', color: '#09090b', width: '100%', padding: 24, paddingBottom: 'calc(24px + var(--dk-inset-bottom))', borderRadius: '16px 16px 0 0' }} onClick={e => e.stopPropagation()}>
        <h2 style={{ marginTop: 0 }}>Sheet</h2>
        <p>The back action closes this first.</p>
      </div>
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

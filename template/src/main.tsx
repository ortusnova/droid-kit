import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Outlet,
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter,
  useMatches,
  useRouter,
} from '@tanstack/react-router';
import { RouterProvider as AriaRouterProvider } from 'react-aria-components';
import { Home } from 'lucide-react';
import { applyStartRoute, installBackHandler, reportErrors, signalReady, syncSystemBars } from '@droid-kit/platform';
import { AppBar, AppShell, RouteError, TabBar, ToastRegion } from '@droid-kit/ui';
import './app.css';
import { APP } from './app-info';
import { HomePage } from './home';
import { AboutPage } from './about';

type Search = { sheet?: string };

// Tabs are routes; a screen below a tab is a nested route; an open sheet is a
// search parameter. Each is a history entry, so the back action closes the
// sheet, then leaves the screen, then goes back through the tabs.
const rootRoute = createRootRoute({
  validateSearch: (s: Record<string, unknown>): Search => (typeof s.sheet === 'string' ? { sheet: s.sheet } : {}),
  component: Shell,
});
const homeRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: HomePage, staticData: { title: APP.title, tab: 'home' } });
const aboutRoute = createRoute({ getParentRoute: () => rootRoute, path: '/about', component: AboutPage, staticData: { title: 'About', tab: 'home', nested: true } });

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
  // A route that fails to render shows RouteError and reports DK_ERROR, so `dk run` names the failure.
  defaultErrorComponent: RouteError,
  routeTree: rootRoute.addChildren([homeRoute, aboutRoute]),
  scrollRestoration: true,
  // One scroll position per screen, whatever sheet is open over it.
  getScrollRestorationKey: location => location.pathname,
  scrollToTopSelectors: ['[data-scroll-restoration-id="main"]'],
});

// Add a tab: a route with `tab: '<id>'` in its staticData, and an entry here.
const TABS = [{ id: 'home', label: 'Home', href: '/', icon: <Home size={20} /> }];

/** The app bar's back: back in history, or up to the parent screen when the app started on this one. */
function goUp(r: ReturnType<typeof useRouter>, pathname: string) {
  if (r.history.canGoBack()) r.history.back();
  else void r.navigate({ to: pathname.replace(/\/[^/]+\/?$/, '') || '/', replace: true });
}

function Shell() {
  const matches = useMatches();
  const leaf = matches[matches.length - 1];
  const r = useRouter();
  useEffect(signalReady, []);

  return (
    <AriaRouterProvider navigate={to => r.navigate({ to })} useHref={to => r.buildLocation({ to }).href}>
      <AppShell
        appBar={<AppBar title={leaf?.staticData.title ?? ''} onBack={leaf?.staticData.nested ? () => goUp(r, leaf.pathname) : undefined} />}
        tabBar={<TabBar tabs={TABS} active={leaf?.staticData.tab ?? 'home'} />}
      >
        <Outlet />
      </AppShell>
      <ToastRegion />
    </AriaRouterProvider>
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

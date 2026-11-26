// The app's frame: app bar, scrolling content, bottom tab bar and floating
// action button. Look from daisyUI (navbar, dock, btn); insets from the
// platform layer's --dk-inset-* variables.
import type { ReactNode } from 'react';
import { Button, Link } from 'react-aria-components';
import { ArrowLeft } from 'lucide-react';
import { dataAttributes, type DataAttributes } from './dom';

/** A full-height screen: app bar on top, tab bar at the bottom, content scrolling between. */
export function AppShell({ appBar, tabBar, fab, children, ...rest }: { appBar?: ReactNode; tabBar?: ReactNode; fab?: ReactNode; children: ReactNode } & DataAttributes) {
  return (
    <div {...dataAttributes(rest)} className="bg-background text-base-content flex h-dvh flex-col overflow-hidden">
      {appBar}
      <div className="relative min-h-0 flex-1">
        <main data-scroll-restoration-id="main" className="h-full overflow-x-hidden overflow-y-auto pb-24" style={{ paddingLeft: 'var(--dk-inset-left)', paddingRight: 'var(--dk-inset-right)' }}>
          {children}
        </main>
        {fab && <div className="absolute right-4 bottom-4" style={{ marginRight: 'var(--dk-inset-right)' }}>{fab}</div>}
      </div>
      {tabBar}
    </div>
  );
}

/**
 * The bar at the top of a screen. Pass `onBack` on screens below a tab's root:
 * Linux phones have no system back action, so this is their only way back.
 */
export function AppBar({ title, subtitle, onBack, actions, ...rest }: { title: string; subtitle?: string; onBack?: () => void; actions?: ReactNode } & DataAttributes) {
  return (
    <header
      {...dataAttributes(rest)}
      className="navbar bg-base-100 border-divider z-10 min-h-0 shrink-0 gap-1 border-b px-2"
      style={{ paddingTop: 'calc(0.5rem + var(--dk-inset-top))', paddingLeft: 'calc(0.5rem + var(--dk-inset-left))', paddingRight: 'calc(0.5rem + var(--dk-inset-right))' }}
    >
      {onBack && (
        <IconButton label="Back" onPress={onBack}>
          <ArrowLeft size={22} />
        </IconButton>
      )}
      <div className={`min-w-0 flex-1 ${onBack ? '' : 'pl-2'}`}>
        {subtitle && <p className="text-caption text-muted truncate">{subtitle}</p>}
        <h1 className="text-title truncate leading-tight font-bold" id="screen-title">{title}</h1>
      </div>
      {actions && <div className="flex flex-none items-center">{actions}</div>}
    </header>
  );
}

export interface Tab {
  id: string;
  label: string;
  href: string;
  icon: ReactNode;
}

/**
 * The bottom tab bar. Tabs are links: wrap the app in React Aria's
 * RouterProvider so they navigate with the app's router.
 */
export function TabBar({ tabs, active, ...rest }: { tabs: Tab[]; active: string } & DataAttributes) {
  return (
    <nav
      {...dataAttributes(rest)}
      aria-label="Sections"
      className="dock bg-base-100 border-divider relative shrink-0 border-t"
      style={{ height: 'auto', paddingBottom: 'var(--dk-inset-bottom)', paddingLeft: 'var(--dk-inset-left)', paddingRight: 'var(--dk-inset-right)' }}
    >
      {tabs.map(t => {
        const isActive = t.id === active;
        return (
          <Link
            key={t.id}
            href={t.href}
            aria-current={isActive ? 'page' : undefined}
            className={`min-h-touch flex h-16 flex-col items-center justify-center gap-0.5 ${isActive ? 'dock-active text-accent-text' : 'text-muted'}`}
          >
            {t.icon}
            <span className="dock-label">{t.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * The floating action button. Not daisyUI's `.fab`: that class turns off
 * pointer events on its first child once it has focus, so a finger tap,
 * which focuses on press, never reaches the button on Android.
 */
export function Fab({ label, onPress, children, ...rest }: { label: string; onPress: () => void; children: ReactNode } & DataAttributes) {
  return (
    <Button {...dataAttributes(rest)} aria-label={label} onPress={onPress} className="btn btn-primary btn-circle size-14 shadow-lg">
      {children}
    </Button>
  );
}

/** An icon-only button with a touch-sized hit area. `label` is its accessible name. */
export function IconButton({ label, onPress, children, isDisabled, ...rest }: { label: string; onPress?: () => void; children: ReactNode; isDisabled?: boolean } & DataAttributes) {
  return (
    <Button {...dataAttributes(rest)} aria-label={label} onPress={onPress} isDisabled={isDisabled} className="btn btn-ghost btn-circle size-touch">
      {children}
    </Button>
  );
}

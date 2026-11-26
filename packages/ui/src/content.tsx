// Content components: daisyUI's card, list, badge, progress and alert, with
// the kit's colour roles.
import type { CSSProperties, ReactNode } from 'react';
import { Link } from 'react-aria-components';
import { ChevronRight, CircleAlert, CircleCheck, Info, TriangleAlert } from 'lucide-react';

export function Card({ title, subtitle, children, actions }: { title?: ReactNode; subtitle?: ReactNode; children?: ReactNode; actions?: ReactNode }) {
  return (
    <section className="card bg-base-100 border-divider border">
      <div className="card-body gap-2 p-4">
        {title && <h2 className="card-title text-title">{title}</h2>}
        {subtitle && <p className="text-small text-muted">{subtitle}</p>}
        {children}
        {actions && <div className="card-actions mt-2 justify-end">{actions}</div>}
      </div>
    </section>
  );
}

/** A grouped list with an optional heading. Children are ListRows, CheckboxRows or SwitchRows. */
export function List({ title, subtitle, children }: { title?: ReactNode; subtitle?: ReactNode; children: ReactNode }) {
  return (
    <section className="bg-base-100 rounded-box border-divider overflow-hidden border">
      {(title || subtitle) && (
        <header className="px-4 pt-3 pb-1">
          {title && <h2 className="text-body font-semibold">{title}</h2>}
          {subtitle && <p className="text-caption text-muted">{subtitle}</p>}
        </header>
      )}
      <ul className="divide-divider divide-y">{children}</ul>
    </section>
  );
}

/** A row in a List. With `href` it is a link to another screen. */
export function ListRow({ title, subtitle, leading, trailing, href }: { title: ReactNode; subtitle?: ReactNode; leading?: ReactNode; trailing?: ReactNode; href?: string }) {
  const body = (
    <>
      {leading && <span className="flex-none">{leading}</span>}
      <span className="min-w-0 flex-1">
        <span className="text-body block font-medium">{title}</span>
        {subtitle && <span className="text-caption text-muted block">{subtitle}</span>}
      </span>
      {trailing}
      {href && <ChevronRight size={18} className="text-muted flex-none" />}
    </>
  );
  const row = 'min-h-touch flex items-center gap-3 px-4 py-2';
  return <li>{href ? <Link href={href} className={`${row} outline-primary focus-visible:outline-2`}>{body}</Link> : <div className={row}>{body}</div>}</li>;
}

export function EmptyState({ icon, title, body, action }: { icon?: ReactNode; title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
      {icon && <div className="text-muted mb-2">{icon}</div>}
      <h2 className="text-title font-bold">{title}</h2>
      {body && <p className="text-muted max-w-xs">{body}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';
const BADGE: Record<Tone, string> = {
  neutral: 'badge-ghost',
  accent: 'badge-secondary',
  success: 'badge-success',
  warning: 'badge-warning',
  danger: 'badge-error',
};

export function Badge({ tone = 'neutral', icon, children }: { tone?: Tone; icon?: ReactNode; children: ReactNode }) {
  return (
    <span className={`badge gap-1 ${BADGE[tone]}`}>
      {icon}
      {children}
    </span>
  );
}

export function ProgressBar({ label, value, max = 100 }: { label: string; value: number; max?: number }) {
  return <progress className="progress progress-primary bg-base-200 w-full" value={value} max={max} aria-label={label} />;
}

/** A ring with a label in the middle, e.g. "4/7". `value` is 0 to 100. */
export function ProgressRing({ label, value, children, size = '4rem' }: { label: string; value: number; children?: ReactNode; size?: string }) {
  const style = { '--value': Math.round(value), '--size': size, '--thickness': '0.4rem' } as CSSProperties;
  return (
    <div className="radial-progress text-primary" style={style} role="progressbar" aria-valuenow={Math.round(value)} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
      <span className="text-base-content text-small font-semibold">{children}</span>
    </div>
  );
}

const CALLOUT: Record<Exclude<Tone, 'neutral'>, { cls: string; icon: ReactNode }> = {
  accent: { cls: 'alert-info', icon: <Info size={22} /> },
  success: { cls: 'alert-success', icon: <CircleCheck size={22} /> },
  warning: { cls: 'alert-warning', icon: <TriangleAlert size={22} /> },
  danger: { cls: 'alert-error', icon: <CircleAlert size={22} /> },
};

/** An inline message. `urgent` announces it to screen readers at once (role=alert). */
export function Callout({ tone = 'accent', title, children, urgent }: { tone?: Exclude<Tone, 'neutral'>; title?: string; children?: ReactNode; urgent?: boolean }) {
  const c = CALLOUT[tone];
  return (
    <div role={urgent ? 'alert' : 'status'} className={`alert alert-soft ${c.cls} items-start`}>
      {c.icon}
      <div className="text-base-content">
        {title && <h3 className="font-bold">{title}</h3>}
        {children && <div className="text-small">{children}</div>}
      </div>
    </div>
  );
}

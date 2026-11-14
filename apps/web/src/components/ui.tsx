import type { ReactNode } from 'react';
import Link from 'next/link';
import { copy, type Locale } from '../lib/copy';

const ICONS: Record<string, ReactNode> = {
  grid: <><rect x="3" y="3" width="7.5" height="7.5" rx="1.6" /><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.6" /><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.6" /><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.6" /></>,
  target: <><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="3.2" /></>,
  user: <><circle cx="12" cy="8.2" r="3.6" /><path d="M4.5 20.5c1.4-3.5 4-5.2 7.5-5.2s6.1 1.7 7.5 5.2" /></>,
  life: <><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="3.6" /><path d="m6 6 3.6 3.6M14.4 14.4 18 18M18 6l-3.6 3.6M9.6 14.4 6 18" /></>,
  layers: <><path d="m12 3.5 8 4.2-8 4.2-8-4.2z" /><path d="m4 12.2 8 4.2 8-4.2" /><path d="m4 16.6 8 4.2 8-4.2" /></>,
  sliders: <><path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2" /><circle cx="10" cy="17" r="2" /></>,
};

export function Icon({ name }: { name: string }) {
  return (
    <svg className="nav-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {ICONS[name] ?? ICONS.grid}
    </svg>
  );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`card ${className}`}>{children}</section>;
}

export function Feedback({ title, children, error = false }: { title: string; children?: ReactNode; error?: boolean }) {
  return <div className={`feedback ${error ? 'error' : ''}`} role={error ? 'alert' : 'status'}><strong>{title}</strong>{children && <p>{children}</p>}</div>;
}

const badgeTones: Record<string, string> = {
  FAILED: 'danger', DISPUTED: 'danger', DENIED: 'danger', REJECTED: 'danger', EXPIRED: 'danger',
  COMPLETED: 'success', DELIVERABLE: 'success', SUPPORTED: 'success', VERIFIED: 'success', APPROVED: 'success',
  WAITING_APPROVAL: 'warning', NEEDS_HUMAN_REVIEW: 'warning', PARTIAL: 'warning', INTERRUPT_REQUESTED: 'warning',
  INTERRUPTED: 'warning', PAYMENT_REQUIRED: 'warning', AWAITING_ACCEPTANCE: 'warning',
  RUNNING: 'info', READY: 'info', QUEUED: 'info', AUTHORIZED: 'info', FULFILLING: 'info',
};

export function StatusBadge({ status, lang }: { status: string; lang: Locale }) {
  const labels = copy[lang].statuses;
  const label = labels[status as keyof typeof labels] ?? status;
  return <span className={`badge ${badgeTones[status] ?? 'neutral'}`} data-status={status}>{label}</span>;
}

export function PageHeader({ eyebrow, title, description, aside }: { eyebrow?: string; title: ReactNode; description?: ReactNode; aside?: ReactNode }) {
  return (
    <header className="qx-page-head">
      {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
      <div className="qx-page-head-row">
        <div className="qx-page-head-copy">
          <h1>{title}</h1>
          {description ? <p className="muted">{description}</p> : null}
        </div>
        {aside ? <div className="qx-page-head-actions">{aside}</div> : null}
      </div>
    </header>
  );
}

export function SectionHeading({ title, note, action }: { title: ReactNode; note?: ReactNode; action?: ReactNode }) {
  return (
    <div className="section-heading">
      <div>
        <h2>{title}</h2>
        {note ? <p className="muted">{note}</p> : null}
      </div>
      {action ?? null}
    </div>
  );
}

export function EmptyState({ title, children, mark = '↗' }: { title: ReactNode; children?: ReactNode; mark?: string }) {
  return (
    <div className="empty">
      <span className="empty-mark" aria-hidden="true">{mark}</span>
      <h3>{title}</h3>
      {children ? <p className="muted">{children}</p> : null}
    </div>
  );
}

function navItems(t: (typeof copy)['en']): readonly (readonly [string, string, string])[] {
  return [
    ['mydash', t.dash, 'grid'],
    ['missions', t.missions, 'target'],
    ['soul', t.soul, 'user'],
    ['support', t.support, 'life'],
    ['capabilities', t.capabilities, 'layers'],
    ['account', t.account, 'sliders'],
  ];
}

function NavLink({ lang, path, label, icon, active }: { lang: Locale; path: string; label: string; icon: string; active: boolean }) {
  return (
    <Link className="nav-link" href={`/${lang}/${path}`} aria-current={active ? 'page' : undefined}>
      <Icon name={icon} />
      <span>{label}</span>
    </Link>
  );
}

export function AppShell({ lang, active, path, children }: { lang: Locale; active: string; path?: string; children: ReactNode }) {
  const t = copy[lang];
  const items = navItems(t);
  const switchPath = path ?? active;
  const title = items.find(([path]) => path === active)?.[1] ?? 'QeyNox';
  const primary = items.slice(0, 3);
  const secondary = items.slice(3);
  return (
    <>
      <a className="skip" href="#content">{t.skip}</a>
      <aside className="sidebar">
        <Link className="brand" href={`/${lang}/mydash`}><span className="mark">Q</span>QeyNox</Link>
        <span className="brand-caption">Results as a Service</span>
        <nav className="desktop-nav" aria-label={t.menu}>
          {primary.map(([path, label, icon]) => <NavLink key={path} lang={lang} path={path} label={label} icon={icon} active={active === path} />)}
          <span className="nav-separator" aria-hidden="true" />
          {secondary.map(([path, label, icon]) => <NavLink key={path} lang={lang} path={path} label={label} icon={icon} active={active === path} />)}
        </nav>
        <details className="mobile-nav">
          <summary>{t.menu}</summary>
          <div className="mobile-nav-links">
            {items.map(([path, label, icon]) => <NavLink key={path} lang={lang} path={path} label={label} icon={icon} active={active === path} />)}
          </div>
        </details>
        <p className="sidebar-note">{t.footer}</p>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <span className="topbar-context">{title}</span>
          <nav className="topbar-actions" aria-label="Language">
            <Link href={`/en/${switchPath}`} lang="en" aria-current={lang === 'en' ? 'true' : undefined}>EN</Link>
            <Link href={`/fr/${switchPath}`} lang="fr" aria-current={lang === 'fr' ? 'true' : undefined}>FR</Link>
          </nav>
        </header>
        <main id="content">{children}</main>
        <footer>{t.footer}</footer>
      </div>
    </>
  );
}

export function CapabilityAvailability({ lang }: { lang: Locale }) {
  const t = copy[lang];
  return (
    <Card>
      <SectionHeading title={t.capabilities} action={<span className="badge neutral">{t.unavailable}</span>} />
      <p className="muted">{t.capabilityCopy}</p>
    </Card>
  );
}

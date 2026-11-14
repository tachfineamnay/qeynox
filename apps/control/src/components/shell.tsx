import Link from 'next/link';
import type { ReactNode } from 'react';
import { copy, type Locale } from '../lib/copy';
import { can, CONSULTATION, LIFECYCLE_READ, OPERATIONS, READ_ORGANIZATIONS, READ_USERS, SUPPORT } from '../lib/permissions';
import { logoutAction } from '../lib/actions';

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={'card ' + className}>{children}</section>;
}
export function Badge({ tone = 'neutral', children }: { tone?: 'neutral' | 'success' | 'warning' | 'danger'; children: ReactNode }) {
  return <span className={'badge ' + tone}>{children}</span>;
}
export function Notice({ tone = 'info', title, children }: { tone?: 'info' | 'success' | 'warning' | 'danger'; title: string; children?: ReactNode }) {
  return <div className={'notice ' + tone} role={tone === 'danger' ? 'alert' : 'status'}><strong>{title}</strong>{children ? <p>{children}</p> : null}</div>;
}
export function Empty({ children }: { children: ReactNode }) { return <p className="empty">{children}</p>; }
export function PageHeader({ title, intro, actions }: { title: string; intro?: string; actions?: ReactNode }) {
  return <header className="page-head"><div><h1>{title}</h1>{intro ? <p className="muted">{intro}</p> : null}</div>{actions ? <div className="page-actions">{actions}</div> : null}</header>;
}
export function OutcomeNotice({ lang, done, error }: { lang: Locale; done?: string; error?: string }) {
  const t = copy[lang];
  if (error) return <Notice tone="danger" title={t.resultError}>{t.apiCode + ': ' + error}</Notice>;
  if (done) return <Notice tone="success" title={t.resultDone} />;
  return null;
}
export function permissionLabels(lang: Locale, permissions: readonly string[]): string {
  const t = copy[lang];
  return permissions.map(permission => {
    if (permission === 'ADMINISTRATION') return t.permissionAdministration;
    if (permission === 'SUPPORT') return t.permissionSupport;
    if (permission === 'OPERATIONS') return t.permissionOperations;
    if (permission === 'CONSULTATION') return t.permissionConsultation;
    return permission;
  }).join(' · ');
}

interface NavItem { readonly href: string; readonly label: string; readonly match: string; readonly allowed: boolean }

export function Shell({ lang, path, permissions, userId, sessionExpiresAt, children }: {
  lang: Locale;
  path: string;
  permissions: readonly string[];
  userId?: string;
  sessionExpiresAt?: string;
  children: ReactNode;
}) {
  const t = copy[lang];
  const other: Locale = lang === 'en' ? 'fr' : 'en';
  const items: NavItem[] = [
    { href: '/' + lang, label: t.navOverview, match: '', allowed: true },
    { href: '/' + lang + '/users', label: t.navUsers, match: 'users', allowed: can(permissions, READ_USERS) },
    { href: '/' + lang + '/organizations', label: t.navOrganizations, match: 'organizations', allowed: can(permissions, READ_ORGANIZATIONS) },
    { href: '/' + lang + '/support', label: t.navSupport, match: 'support', allowed: can(permissions, SUPPORT) },
    { href: '/' + lang + '/operations', label: t.navOperations, match: 'operations', allowed: can(permissions, OPERATIONS) },
    { href: '/' + lang + '/audit', label: t.navAudit, match: 'audit', allowed: can(permissions, CONSULTATION) },
    { href: '/' + lang + '/account', label: t.navAccount, match: 'account', allowed: true },
  ];
  const activeKey = path.split('/').filter(Boolean)[0] ?? '';
  const nav = (
    <nav aria-label={t.menu}>
      {items.filter(item => item.allowed).map(item => (
        <Link key={item.href} href={item.href} aria-current={activeKey === item.match ? 'page' : undefined}>{item.label}</Link>
      ))}
    </nav>
  );
  const localeHref = '/' + other + path;
  return (
    <>
      <a className="skip" href="#content">{t.skip}</a>
      <div className="shell">
        <aside className="sidebar">
          <Link className="brand" href={'/' + lang}><span className="mark">Q</span><span className="brand-text">{t.brand}<small>{t.brandCaption}</small></span></Link>
          <div className="desktop-nav">{nav}</div>
          <details className="mobile-nav"><summary>{t.menu}</summary>{nav}</details>
          <div className="sidebar-foot">
            {userId ? <p className="session-note">{userId}{sessionExpiresAt ? <><br /><span>{t.sessionExpires + ': ' + new Date(sessionExpiresAt).toLocaleString(lang)}</span></> : null}</p> : null}
            <div className="sidebar-actions">
              <Link href={localeHref} hrefLang={other}>{other.toUpperCase()}</Link>
              <form action={logoutAction}><input type="hidden" name="lang" value={lang} /><button className="link-button" type="submit">{t.signOut}</button></form>
            </div>
          </div>
        </aside>
        <div className="workspace">
          <main id="content" className="content">{children}</main>
          <footer className="foot"><span>{t.mobileNote}</span></footer>
        </div>
      </div>
    </>
  );
}

export function PermissionDenied({ lang }: { lang: Locale }) {
  return <Notice tone="warning" title={copy[lang].permissionDenied}>{copy[lang].backToDashboard + ': '}<Link href={'/' + lang}>{copy[lang].navOverview}</Link></Notice>;
}

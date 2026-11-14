import Link from 'next/link';
import { Fragment, type ReactNode } from 'react';
import { copy, type Locale } from '../lib/copy';
import { can, CONSULTATION, OPERATIONS, READ_ASSIGNMENTS, READ_CATALOGUE, READ_ORGANIZATIONS, READ_USERS, SUPPORT } from '../lib/permissions';
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
const errorKeys: Record<string, string> = {
  SESSION_REQUIRED: 'errorSessionRequired', DENIED: 'errorDenied', NOT_FOUND: 'errorNotFound',
  CONFLICT: 'errorConflict', INVALID_INPUT: 'errorInvalid', NOT_CONFIGURED: 'errorNotConfigured',
  UNAVAILABLE: 'errorUnavailable', UNKNOWN_OUTCOME: 'errorUnknown',
};

/** Maps server error codes to actionable localised text while keeping the code visible. */
export function errorMessage(lang: Locale, code: string): string {
  const messages = copy[lang] as unknown as Record<string, string>;
  return messages[errorKeys[code] ?? 'errorUnknown'] ?? code;
}

export function ApiErrorNotice({ lang, code }: { lang: Locale; code: string }) {
  return <Notice tone="warning" title={copy[lang].apiUnavailable}>{errorMessage(lang, code) + ' (' + code + ')'}</Notice>;
}

export function OutcomeNotice({ lang, done, error }: { lang: Locale; done?: string; error?: string }) {
  const t = copy[lang];
  if (error) return <Notice tone="danger" title={t.resultError}>{errorMessage(lang, error) + ' (' + error + ')'}</Notice>;
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

interface NavItem { readonly href: string; readonly label: string; readonly match: string; readonly allowed: boolean; readonly group: string }

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
    { href: '/' + lang, label: t.navOverview, match: '', allowed: true, group: '' },
    { href: '/' + lang + '/users', label: t.navUsers, match: 'users', allowed: can(permissions, READ_USERS), group: t.groupCustomer },
    { href: '/' + lang + '/organizations', label: t.navOrganizations, match: 'organizations', allowed: can(permissions, READ_ORGANIZATIONS), group: t.groupCustomer },
    { href: '/' + lang + '/support', label: t.navSupport, match: 'support', allowed: can(permissions, SUPPORT), group: t.groupCustomer },
    { href: '/' + lang + '/admins', label: t.navAdmins, match: 'admins', allowed: can(permissions, READ_ASSIGNMENTS), group: t.groupPlatform },
    { href: '/' + lang + '/settings', label: t.navSettings, match: 'settings', allowed: can(permissions, READ_CATALOGUE), group: t.groupPlatform },
    { href: '/' + lang + '/audit', label: t.navAudit, match: 'audit', allowed: can(permissions, CONSULTATION), group: t.groupPlatform },
    { href: '/' + lang + '/operations', label: t.navOperations, match: 'operations', allowed: can(permissions, OPERATIONS), group: t.groupOperations },
    { href: '/' + lang + '/operations/health', label: t.navHealth, match: 'operations', allowed: can(permissions, OPERATIONS), group: t.groupOperations },
    { href: '/' + lang + '/operations/releases', label: t.navReleases, match: 'operations', allowed: can(permissions, OPERATIONS), group: t.groupOperations },
    { href: '/' + lang + '/account', label: t.navAccount, match: 'account', allowed: true, group: '' },
  ];
  const activeKey = path.split('/').filter(Boolean)[0] ?? '';
  const visible = items.filter(item => item.allowed);
  const nav = (
    <nav aria-label={t.menu}>
      {visible.map((item, index) => (
        <Fragment key={item.href}>
          {item.group && visible[index - 1]?.group !== item.group ? <span className="nav-group">{item.group}</span> : null}
          <Link href={item.href} aria-current={activeKey === item.match ? 'page' : undefined}>{item.label}</Link>
        </Fragment>
      ))}
    </nav>
  );
  const search = can(permissions, READ_USERS) ? (
    <form className="sidebar-search" method="get" action={'/admin/' + lang + '/users'} role="search">
      <label className="sr-only" htmlFor="qx-control-search">{t.searchUsers}</label>
      <input id="qx-control-search" name="query" placeholder={t.searchPlaceholder} autoComplete="off" />
      <button className="button secondary" type="submit">{t.searchUsers}</button>
    </form>
  ) : null;
  const localeHref = '/' + other + path;
  return (
    <>
      <a className="skip" href="#content">{t.skip}</a>
      <div className="shell">
        <aside className="sidebar">
          <Link className="brand" href={'/' + lang}><span className="mark">Q</span><span className="brand-text">{t.brand}<small>{t.brandCaption}</small></span></Link>
          {search}
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

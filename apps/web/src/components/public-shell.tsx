import Link from 'next/link';
import type { ReactNode } from 'react';
import type { Locale } from '../lib/copy';
import { publicCopy } from '../lib/public-content';

/**
 * Public marketing shell. Server-rendered only: the mobile navigation uses native <details>, so the
 * public pages ship no client JavaScript. Application pages keep their existing AppShell.
 */
export function PublicShell({ lang, path, children }: { lang: Locale; path: string; children: ReactNode }) {
  const c = publicCopy[lang];
  const other: Locale = lang === 'en' ? 'fr' : 'en';
  const nav = [
    { path: '', label: c.nav.home },
    { path: 'how-it-works', label: c.nav.how },
    { path: 'manifesto', label: c.nav.manifesto },
    { path: 'contact', label: c.nav.contact },
  ];
  const legal = [
    { path: 'legal/notice', label: lang === 'en' ? 'Legal notice' : 'Mentions légales' },
    { path: 'legal/privacy', label: lang === 'en' ? 'Privacy' : 'Confidentialité' },
    { path: 'legal/terms', label: lang === 'en' ? 'Terms' : 'CGU' },
    { path: 'legal/cookies', label: lang === 'en' ? 'Cookies' : 'Cookies' },
  ];
  return (
    <>
      <a className="skip" href="#content">{lang === 'en' ? 'Skip to content' : 'Aller au contenu'}</a>
      <div className="public-shell">
        <header className="public-header">
          <div className="public-header-inner">
            <Link className="public-brand" href={'/' + lang}>
              <span className="mark" aria-hidden="true">Q</span>
              <span>QeyNox<small>{c.brandCaption}</small></span>
            </Link>
            <nav className="public-nav" aria-label={lang === 'en' ? 'Public navigation' : 'Navigation publique'}>
              {nav.map(item => <Link key={item.path} href={'/' + lang + (item.path.length ? '/' + item.path : '')}>{item.label}</Link>)}
            </nav>
            <div className="public-actions">
              <Link className="public-lang" href={'/' + other + path} hrefLang={other} aria-label={c.language}>{other.toUpperCase()}</Link>
              <Link className="public-button small secondary" href={'/' + lang + '/account'}>{c.nav.signin}</Link>
              <Link className="public-button small" href={'/' + lang + '/mydash'}>{c.nav.enter}</Link>
            </div>
            <details className="public-mobile">
              <summary>{lang === 'en' ? 'Menu' : 'Menu'}</summary>
              <div className="public-mobile-panel">
                {nav.map(item => <Link key={item.path} href={'/' + lang + (item.path.length ? '/' + item.path : '')}>{item.label}</Link>)}
                <Link href={'/' + lang + '/account'}>{c.nav.signin}</Link>
                <Link href={'/' + lang + '/mydash'}>{c.nav.enter}</Link>
                <Link href={'/' + other + path} hrefLang={other}>{other.toUpperCase()}</Link>
              </div>
            </details>
          </div>
        </header>
        <main id="content" className="public-main">{children}</main>
        <footer className="public-footer">
          <div className="public-container public-footer-grid">
            <div>
              <p className="public-footer-brand">QeyNox</p>
              <p>{c.footer.tagline}</p>
            </div>
            <nav aria-label={c.footer.legalTitle}>
              <p className="public-footer-title">{c.footer.legalTitle}</p>
              <ul>
                {legal.map(item => <li key={item.path}><Link href={'/' + lang + '/' + item.path}>{item.label}</Link></li>)}
                <li><Link href={'/' + lang + '/contact'}>{c.nav.contact}</Link></li>
              </ul>
            </nav>
            <div>
              <p className="legal-pending-inline">{c.footer.pending}</p>
              <p className="public-footer-meta">{lang === 'en' ? 'QeyNox — Results as a Service' : 'QeyNox — Results as a Service'}</p>
            </div>
          </div>
        </footer>
      </div>
    </>
  );
}

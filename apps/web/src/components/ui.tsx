import type { ReactNode } from 'react';
import Link from 'next/link';
import { copy, type Locale } from '../lib/copy';
export function Card({ children, className = '' }: { children: ReactNode; className?: string }) { return <section className={`card ${className}`}>{children}</section>; }
export function Feedback({ title, children, error = false }: { title: string; children?: ReactNode; error?: boolean }) { return <div className={`feedback ${error ? 'error' : ''}`} role={error ? 'alert' : 'status'}><strong>{title}</strong>{children && <p>{children}</p>}</div>; }
export function StatusBadge({ status, lang }: { status: string; lang: Locale }) {
  const labels = copy[lang].statuses;
  const label = labels[status as keyof typeof labels] ?? status;
  const tone = status === 'FAILED' ? 'danger' : status === 'COMPLETED' ? 'success' : status === 'WAITING_APPROVAL' ? 'warning' : 'neutral';
  return <span className={`badge ${tone}`}>{label}</span>;
}
export function AppShell({ lang, active, children }: { lang: Locale; active: string; children: ReactNode }) {
  const t = copy[lang];
  const links = [['', t.home], ['mydash', t.dash], ['missions', t.missions], ['soul', t.soul], ['support', t.support], ['capabilities', t.capabilities], ['account', t.account]];
  const nav = <nav aria-label={t.menu}>{links.map(([path, label]) => <Link key={path} href={`/${lang}/${path}`} aria-current={active === path ? 'page' : undefined}>{label}</Link>)}</nav>;
  return <><a className="skip" href="#content">{t.skip}</a><aside className="sidebar"><Link className="brand" href={`/${lang}`}><span className="mark">Q</span>QeyNox</Link><span className="brand-caption">Results as a Service</span><div className="desktop-nav">{nav}</div><details className="mobile-nav"><summary>{t.menu}</summary>{nav}</details><p className="sidebar-note">{t.footer}</p></aside><div className="workspace"><header className="topbar"><span>{active === '' ? 'QeyNox' : t.dash}</span><nav aria-label="Language"><Link href={`/en/${active}`} lang="en" aria-current={lang === 'en' ? 'true' : undefined}>EN</Link><Link href={`/fr/${active}`} lang="fr" aria-current={lang === 'fr' ? 'true' : undefined}>FR</Link></nav></header><main id="content">{children}</main><footer>{t.footer}</footer></div></>;
}
export function CapabilityAvailability({ lang }: { lang: Locale }) { const t = copy[lang]; return <Card><div className="section-heading"><h2>{t.capabilities}</h2><span className="badge neutral">{t.unavailable}</span></div><p className="muted">{t.capabilityCopy}</p></Card>; }

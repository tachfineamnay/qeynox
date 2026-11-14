import Link from 'next/link';
import type { Locale } from '../lib/copy';
import { publicCopy, legalPlaceholders, type LegalPageCopy } from '../lib/public-content';
import { PublicShell } from './public-shell';

export function LegalPage({ lang, path, page }: { lang: Locale; path: string; page: LegalPageCopy }) {
  const c = publicCopy[lang];
  return (
    <PublicShell lang={lang} path={path}>
      <section className="public-hero public-hero-compact">
        <div className="public-container">
          <p className="public-eyebrow">{c.footer.legalTitle}</p>
          <h1>{page.title}</h1>
          <p className="public-lead">{page.intro}</p>
        </div>
      </section>
      <section className="public-section">
        <div className="public-container public-prose">
          {page.requiresPlaceholders ? (
            <div className="legal-pending" role="note">
              <strong>{c.pending.title}</strong>
              <p>{c.pending.intro}</p>
              <ul>{legalPlaceholders[lang].map(item => <li key={item}>{item}</li>)}</ul>
            </div>
          ) : null}
          {page.sections.map(section => (
            <section key={section.heading}>
              <h2>{section.heading}</h2>
              {section.paragraphs.map(paragraph => <p key={paragraph}>{paragraph}</p>)}
            </section>
          ))}
          <p className="public-back"><Link href={'/' + lang}>{'← ' + (lang === 'en' ? 'Back to home' : 'Retour à l’accueil')}</Link></p>
        </div>
      </section>
    </PublicShell>
  );
}

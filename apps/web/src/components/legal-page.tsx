import Link from 'next/link';
import type { Locale } from '../lib/copy';
import { publicCopy, type LegalPageCopy } from '../lib/public-content';
import { publicationState } from '../lib/publication';
import { PendingDetailsBlock, VerifiedDetailsBlock } from './publication-blocks';
import { PublicShell } from './public-shell';

/**
 * MISSION A03 — the legal pages render the publication state instead of a static placeholder list:
 * verified values supplied by the operator appear in a verified-details block, and only the fields
 * still missing are listed as pending.
 */
export function LegalPage({ lang, path, page }: { lang: Locale; path: string; page: LegalPageCopy }) {
  const c = publicCopy[lang];
  const state = publicationState();
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
            <>
              <PendingDetailsBlock state={state} lang={lang} />
              <VerifiedDetailsBlock state={state} lang={lang} />
            </>
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

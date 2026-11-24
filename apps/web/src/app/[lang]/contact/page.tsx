import type { Metadata } from 'next';
import { locale } from '../../../lib/copy';
import { pageMetadata } from '../../../lib/site';
import { publicCopy } from '../../../lib/public-content';
import { publicationState } from '../../../lib/publication';
import { PendingDetailsBlock } from '../../../components/publication-blocks';
import { PublicShell } from '../../../components/public-shell';

// The publication details come from the deployment environment at request time, so the page must
// never be prerendered with build-time values (MISSION A03).
export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const lang = locale((await params).lang);
  return pageMetadata(lang, 'contact', publicCopy[lang].contact.title, publicCopy[lang].contact.description);
}

export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const lang = locale((await params).lang);
  const c = publicCopy[lang];
  // Only a VERIFIED address is published. A configured value that fails validation is never
  // rendered (fail closed): the page falls back to the pending state.
  const state = publicationState();
  const contactEmail = state.contactEmail.status === 'VERIFIED' ? state.contactEmail.value : null;
  return (
    <PublicShell lang={lang} path="contact">
      <section className="public-hero public-hero-compact">
        <div className="public-container">
          <p className="public-eyebrow">{c.nav.contact}</p>
          <h1>{c.contact.h1}</h1>
          <p className="public-lead">{c.contact.lead}</p>
        </div>
      </section>
      <section className="public-section">
        <div className="public-container public-two-col">
          <article className="public-card">
            <h2>{c.contact.supportTitle}</h2>
            <p>{c.contact.supportBody}</p>
          </article>
          <article className="public-card">
            <h2>{c.contact.publicTitle}</h2>
            <p>{c.contact.publicBody}</p>
            {contactEmail ? (
              <>
                <p>{c.contact.publicVerified}</p>
                <p><a href={'mailto:' + contactEmail}>{contactEmail}</a></p>
              </>
            ) : (
              <p className="legal-pending-inline">{c.contact.publicMissing}</p>
            )}
          </article>
        </div>
      </section>
      <section className="public-section">
        <div className="public-container public-prose">
          <p>{c.contact.legalPendingBody}</p>
          <PendingDetailsBlock state={state} lang={lang} />
        </div>
      </section>
    </PublicShell>
  );
}

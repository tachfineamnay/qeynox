import type { Metadata } from 'next';
import { locale } from '../../../lib/copy';
import { pageMetadata } from '../../../lib/site';
import { legalPlaceholders, publicCopy } from '../../../lib/public-content';
import { PublicShell } from '../../../components/public-shell';

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const lang = locale((await params).lang);
  return pageMetadata(lang, 'contact', publicCopy[lang].contact.title, publicCopy[lang].contact.description);
}

export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const lang = locale((await params).lang);
  const c = publicCopy[lang];
  const contactEmail = (process.env.QEYNOX_CONTACT_EMAIL ?? '').trim();
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
            {contactEmail.length ? (
              <p><a href={'mailto:' + contactEmail}>{contactEmail}</a></p>
            ) : (
              <p className="legal-pending-inline">{c.contact.publicMissing}</p>
            )}
          </article>
        </div>
      </section>
      <section className="public-section">
        <div className="public-container public-prose">
          <div className="legal-pending" role="note">
            <strong>{c.pending.title}</strong>
            <p>{c.contact.legalPendingBody}</p>
            <ul>{legalPlaceholders[lang].map(item => <li key={item}>{item}</li>)}</ul>
          </div>
        </div>
      </section>
    </PublicShell>
  );
}

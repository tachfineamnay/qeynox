import type { Metadata } from 'next';
import { locale } from '../../../lib/copy';
import { pageMetadata } from '../../../lib/site';
import { publicCopy } from '../../../lib/public-content';
import { PublicShell } from '../../../components/public-shell';

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const lang = locale((await params).lang);
  return pageMetadata(lang, 'manifesto', publicCopy[lang].manifesto.title, publicCopy[lang].manifesto.description);
}

export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const lang = locale((await params).lang);
  const c = publicCopy[lang];
  return (
    <PublicShell lang={lang} path="manifesto">
      <section className="public-hero public-hero-compact">
        <div className="public-container">
          <p className="public-eyebrow">{c.nav.manifesto}</p>
          <h1>{c.manifesto.h1}</h1>
          <p className="public-lead">{c.manifesto.lead}</p>
        </div>
      </section>
      <section className="public-section">
        <div className="public-container public-prose">
          {c.manifesto.paragraphs.map(paragraph => <p key={paragraph}>{paragraph}</p>)}
        </div>
      </section>
      <section className="public-section public-section-soft">
        <div className="public-container">
          <h2>{c.manifesto.principlesTitle}</h2>
          <div className="public-grid">
            {c.manifesto.principles.map(principle => (
              <article key={principle.title} className="public-card"><h3>{principle.title}</h3><p>{principle.body}</p></article>
            ))}
          </div>
        </div>
      </section>
    </PublicShell>
  );
}

import Link from 'next/link';
import type { Metadata } from 'next';
import { locale } from '../../../lib/copy';
import { pageMetadata } from '../../../lib/site';
import { publicCopy } from '../../../lib/public-content';
import { PublicShell } from '../../../components/public-shell';

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const lang = locale((await params).lang);
  return pageMetadata(lang, 'how-it-works', publicCopy[lang].how.title, publicCopy[lang].how.description);
}

export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const lang = locale((await params).lang);
  const c = publicCopy[lang];
  return (
    <PublicShell lang={lang} path="how-it-works">
      <section className="public-hero public-hero-compact">
        <div className="public-container">
          <p className="public-eyebrow">{c.nav.how}</p>
          <h1>{c.how.h1}</h1>
          <p className="public-lead">{c.how.lead}</p>
        </div>
      </section>
      <section className="public-section">
        <div className="public-container">
          <h2>{c.how.stepsTitle}</h2>
          <ol className="public-steps">
            {c.how.steps.map((step, index) => (
              <li key={step.title}><span className="public-step-number">{'0' + (index + 1)}</span><h3>{step.title}</h3><p>{step.body}</p></li>
            ))}
          </ol>
        </div>
      </section>
      <section className="public-section public-section-soft">
        <div className="public-container public-two-col">
          <div><h2>{c.how.doesTitle}</h2><ul className="public-check-list">{c.how.does.map(item => <li key={item}>{item}</li>)}</ul></div>
          <div><h2>{c.how.doesNotTitle}</h2><ul className="public-cross-list">{c.how.doesNot.map(item => <li key={item}>{item}</li>)}</ul></div>
        </div>
      </section>
      <section className="public-section">
        <div className="public-container public-prose">
          <h2>{c.how.capabilitiesTitle}</h2>
          <p>{c.how.capabilities}</p>
          <div className="public-cta-row">
            <Link className="public-button" href={'/' + lang + '/account'}>{c.nav.signin}</Link>
            <Link className="public-button secondary" href={'/' + lang + '/manifesto'}>{c.nav.manifesto}</Link>
          </div>
        </div>
      </section>
    </PublicShell>
  );
}

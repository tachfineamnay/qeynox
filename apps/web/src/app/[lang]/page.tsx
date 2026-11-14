import Link from 'next/link';
import type { Metadata } from 'next';
import { locale } from '../../lib/copy';
import { pageMetadata } from '../../lib/site';
import { publicCopy } from '../../lib/public-content';
import { PublicShell } from '../../components/public-shell';

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const lang = locale((await params).lang);
  return pageMetadata(lang, '', publicCopy[lang].home.title, publicCopy[lang].home.description);
}

export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const lang = locale((await params).lang);
  const c = publicCopy[lang];
  return (
    <PublicShell lang={lang} path="">
      <section className="public-hero">
        <div className="public-container">
          <p className="public-eyebrow">{c.home.eyebrow}</p>
          <h1>{c.home.h1}</h1>
          <p className="public-lead">{c.home.lead}</p>
          <div className="public-cta-row">
            <Link className="public-button" href={'/' + lang + '/mydash'}>{c.home.primary}</Link>
            <Link className="public-button secondary" href={'/' + lang + '/how-it-works'}>{c.home.secondary}</Link>
          </div>
          <p className="public-hero-note">{c.home.limits}</p>
        </div>
      </section>
      <section className="public-section">
        <div className="public-container">
          <h2>{c.home.valuesTitle}</h2>
          <div className="public-grid">
            {c.home.values.map(value => (
              <article key={value.title} className="public-card"><h3>{value.title}</h3><p>{value.body}</p></article>
            ))}
          </div>
        </div>
      </section>
      <section className="public-section public-section-soft">
        <div className="public-container">
          <h2>{c.home.stepsTitle}</h2>
          <ol className="public-steps">
            {c.home.steps.map((step, index) => (
              <li key={step.title}><span className="public-step-number">{'0' + (index + 1)}</span><h3>{step.title}</h3><p>{step.body}</p></li>
            ))}
          </ol>
          <p><Link href={'/' + lang + '/how-it-works'}>{c.nav.how} →</Link></p>
        </div>
      </section>
      <section className="public-section">
        <div className="public-container public-two-col">
          <div>
            <h2>{c.home.evidenceTitle}</h2>
            <p>{c.home.evidenceIntro}</p>
            <ul className="public-check-list">{c.home.evidence.map(item => <li key={item}>{item}</li>)}</ul>
          </div>
          <div>
            <h2>{c.home.limitsTitle}</h2>
            <p>{c.home.limits}</p>
          </div>
        </div>
      </section>
      <section className="public-section public-section-navy">
        <div className="public-container">
          <p className="public-eyebrow">{c.nav.manifesto}</p>
          <h2>{c.home.manifestoTitle}</h2>
          <p className="public-lead">{c.home.manifestoBody}</p>
          <p><Link className="public-button secondary" href={'/' + lang + '/manifesto'}>{c.home.manifestoLink} →</Link></p>
        </div>
      </section>
      <section className="public-section">
        <div className="public-container public-final-cta">
          <h2>{c.home.ctaTitle}</h2>
          <p>{c.footer.tagline}</p>
          <div className="public-cta-row">
            <Link className="public-button" href={'/' + lang + '/account'}>{c.nav.signin}</Link>
            <Link className="public-button secondary" href={'/' + lang + '/contact'}>{c.nav.contact}</Link>
          </div>
        </div>
      </section>
    </PublicShell>
  );
}

import Link from 'next/link';
import { publicCopy } from '../../lib/public-content';
import { PublicShell } from '../../components/public-shell';

/**
 * MISSION A03 — honest 404 for the public site. The not-found boundary receives no params, so the
 * content is bilingual by construction (EN/FR in one message); the shell renders when the locale
 * segment itself is valid, and the same message stands alone when an unsupported locale path is
 * requested. No invented content: only the navigation back to real pages.
 */
export default function NotFound() {
  const c = publicCopy.en.notFound;
  const fr = publicCopy.fr.notFound;
  return (
    <PublicShell lang="en" path="">
      <section className="public-hero public-hero-compact">
        <div className="public-container">
          <p className="public-eyebrow">404</p>
          <h1>{c.title} — {fr.title}</h1>
          <p className="public-lead">{c.body}</p>
        </div>
      </section>
      <section className="public-section">
        <div className="public-container public-prose">
          <p className="public-back">
            <Link href="/en">{c.backHome}</Link>
          </p>
        </div>
      </section>
    </PublicShell>
  );
}

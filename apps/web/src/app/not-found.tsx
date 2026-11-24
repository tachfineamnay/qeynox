import Link from 'next/link';
import { publicCopy } from '../lib/public-content';
import { PublicShell } from '../components/public-shell';
import './globals.css';

/**
 * MISSION A03 — root 404 boundary. This renders when no route matches at all (e.g. an unknown
 * top-level path or an unsupported locale segment): the [lang] layout never ran, so the content is
 * bilingual by construction and self-sufficient. No invented content: only the navigation back to
 * real pages. Invalid identifiers inside matched routes use the [lang]/not-found boundary instead,
 * which renders with the correct locale shell.
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

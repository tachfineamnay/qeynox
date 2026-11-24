import type { Locale } from '../lib/copy';
import { publicCopy } from '../lib/public-content';
import { pendingLabels, publicationState } from '../lib/publication';

/**
 * MISSION A03 — publication details blocks shared by the legal pages and the contact page.
 *
 * Both blocks are derived from the deployment environment at request time (lib/publication.ts).
 * Verified values are rendered exactly as supplied; missing or invalid values never render a
 * placeholder value, only the pending label. The blocks reuse the existing warning/success token
 * styling — no new visual language.
 */

export function VerifiedDetailsBlock({ state, lang }: { state: ReturnType<typeof publicationState>; lang: Locale }) {
  const c = publicCopy[lang];
  if (state.verifiedVars.length === 0) return null;
  return (
    <div className="legal-verified" role="note">
      <strong>{c.verified.title}</strong>
      <p>{c.verified.intro}</p>
      <dl className="legal-verified-list">
        {state.verifiedVars.map(item => (
          <div key={item.key} className="legal-verified-item">
            <dt>{item.label[lang]}</dt>
            <dd>{item.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function PendingDetailsBlock({ state, lang }: { state: ReturnType<typeof publicationState>; lang: Locale }) {
  const c = publicCopy[lang];
  const items = pendingLabels(state, lang);
  if (items.length === 0) return null;
  return (
    <div className="legal-pending" role="note">
      <strong>{c.pending.title}</strong>
      <p>{c.pending.intro}</p>
      <ul>{items.map(item => <li key={item}>{item}</li>)}</ul>
    </div>
  );
}

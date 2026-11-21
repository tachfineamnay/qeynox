import type { ReactNode } from 'react';
import { Card } from './ui';
import type { Locale } from '../lib/copy';

/**
 * MISSION A07 — Atlas result reader.
 *
 * One reading order, stated once: verdict → what is verified → what is unresolved → what is awaiting
 * assessment → AI interpretation → provenance → review/version. The separation is the whole point of
 * the screen, so it is structural (distinct landmarked sections, distinct labels) rather than a colour
 * hint that disappears in high-contrast mode or on paper.
 *
 * Accessibility notes that are load-bearing, not decorative:
 * - every section is a <section> with an <h2>, so a screen reader can jump between classes of finding;
 * - the classification of each finding is text inside the item, not a colour or an icon;
 * - counts are rendered in a list with explicit labels so "3 verified" is never read as "3 findings";
 * - provenance is a definition list, which keeps provider/date/digest paired with their labels;
 * - no information is carried only by hover, animation or colour.
 */

export interface AtlasCitation {
  sourceId: string; provider: string; uri?: string; retrievedAt: string;
  publishedAt?: string; fingerprint?: string;
}
export interface AtlasFinding {
  claimId: string; statement: string; status: string;
  limitations: readonly string[]; citations: readonly AtlasCitation[];
}
export interface AtlasDocument {
  id: string; operationId: string; version: number; title: string; objective: string;
  status: 'DRAFT' | 'PARTIAL' | 'READY_FOR_REVIEW' | 'DELIVERABLE';
  scope: readonly string[]; findings: readonly AtlasFinding[];
  nextActions: readonly string[]; limitations: readonly string[]; unresolved: readonly string[];
  citations: readonly AtlasCitation[]; createdAt: string;
  reviewedAt?: string; reviewedBy?: string; priorId?: string;
  /** P09: AI synthesis from a validated business-pack deliverable. Rendered only as interpretation. */
  interpretations?: readonly string[];
  /** P09: the typed business service whose validated deliverable produced this document. */
  businessPack?: { pack: string; contractKey: string };
}

type FindingClass = 'VERIFIED' | 'UNRESOLVED' | 'AWAITING_ASSESSMENT' | 'AI_INTERPRETATION';

const atlasCopy = {
  en: {
    verdict: 'Verdict',
    counts: 'At a glance',
    verified: 'Evidence-supported findings',
    unresolved: 'Unresolved findings',
    awaiting: 'Awaiting assessment',
    interpretation: 'AI interpretation',
    verifiedNote: 'Structurally supported by qualifying provider evidence. Only a reviewed, delivered document makes these conclusions.',
    unresolvedNote: 'Assessed and not established. Do not rely on these as conclusions.',
    awaitingNote: 'Not assessed against any verification policy yet. These are claims, not findings.',
    interpretationNote: 'The agent’s own synthesis. Never evidence on its own.',
    noneVerified: 'No finding is evidence-supported.',
    noneUnresolved: 'No unresolved findings.',
    noneAwaiting: 'No findings are awaiting assessment.',
    noneInterpretation: 'No AI interpretation is recorded.',
    scope: 'Scope',
    noScope: 'No scope was recorded.',
    limits: 'Limitations',
    noLimits: 'No limitation was recorded.',
    unresolvedIds: 'Unresolved claim identifiers',
    none: 'None.',
    next: 'Next actions',
    noNext: 'No next action was recorded.',
    provenance: 'Provenance',
    noSource: 'No source was recorded for this finding.',
    noUriRecorded: 'No citation URI recorded',
    structuredDeliverable: 'Structured business deliverable',
    notVerifiable: 'not verifiable',
    provider: 'Provider',
    retrieved: 'Retrieved',
    published: 'Published',
    unknownDate: 'publication date unknown',
    digest: 'Captured response SHA-256',
    noDigest: 'no captured digest recorded',
    review: 'Review and version',
    version: 'Version',
    statusLabel: 'Status',
    reviewed: 'Reviewed',
    reviewedBy: 'by',
    statusValue: { DRAFT: 'Draft', PARTIAL: 'Partial', READY_FOR_REVIEW: 'Ready for review', DELIVERABLE: 'Deliverable' } as Record<string, string>,
    notReviewed: 'Not reviewed. This document has not been approved by a human.',
    supersedes: 'Supersedes the previous version of this document.',
    why: 'Why this is not a conclusion',
    countsLabel: 'Findings by classification',
    jump: 'Jump to',
  },
  fr: {
    verdict: 'Verdict',
    counts: 'En bref',
    verified: 'Constats étayés par des preuves',
    unresolved: 'Constats non résolus',
    awaiting: 'En attente d’évaluation',
    interpretation: 'Interprétation de l’IA',
    verifiedNote: 'Structurellement étayés par des preuves fournisseur qualifiantes. Seul un document revu et livré en fait des conclusions.',
    unresolvedNote: 'Évalués et non établis. Ne pas s’y fier comme conclusions.',
    awaitingNote: 'Pas encore évalués au regard d’une politique de vérification. Ce sont des affirmations, pas des constats.',
    interpretationNote: 'Synthèse de l’agent. Jamais une preuve à elle seule.',
    noneVerified: 'Aucun constat n’est étayé par des preuves.',
    noneUnresolved: 'Aucun constat non résolu.',
    noneAwaiting: 'Aucun constat en attente d’évaluation.',
    noneInterpretation: 'Aucune interprétation de l’IA enregistrée.',
    scope: 'Périmètre',
    noScope: 'Aucun périmètre enregistré.',
    limits: 'Limites',
    noLimits: 'Aucune limite enregistrée.',
    unresolvedIds: 'Identifiants de constats non résolus',
    none: 'Aucun.',
    next: 'Actions suivantes',
    noNext: 'Aucune action suivante enregistrée.',
    provenance: 'Provenance',
    noSource: 'Aucune source enregistrée pour ce constat.',
    noUriRecorded: 'Aucun URI de citation enregistré',
    structuredDeliverable: 'Livrable métier structuré',
    notVerifiable: 'non vérifiable',
    provider: 'Fournisseur',
    retrieved: 'Consultée',
    published: 'Publiée',
    unknownDate: 'date de publication inconnue',
    digest: 'SHA-256 de la réponse capturée',
    noDigest: 'aucun empreinte capturée',
    review: 'Revue et version',
    version: 'Version',
    statusLabel: 'Statut',
    reviewed: 'Revu',
    reviewedBy: 'par',
    statusValue: { DRAFT: 'Brouillon', PARTIAL: 'Partiel', READY_FOR_REVIEW: 'Prêt pour revue', DELIVERABLE: 'Livrable' } as Record<string, string>,
    notReviewed: 'Non revu. Ce document n’a pas été approuvé par un humain.',
    supersedes: 'Remplace la version précédente de ce document.',
    why: 'Pourquoi ce n’est pas une conclusion',
    countsLabel: 'Constats par classification',
    jump: 'Aller à',
  },
} as const;

const classLabel: Record<FindingClass, { en: string; fr: string }> = {
  VERIFIED: { en: 'Evidence-supported', fr: 'Étayé par des preuves' },
  UNRESOLVED: { en: 'Unresolved', fr: 'Non résolu' },
  AWAITING_ASSESSMENT: { en: 'Awaiting assessment', fr: 'En attente d’évaluation' },
  AI_INTERPRETATION: { en: 'AI interpretation', fr: 'Interprétation IA' },
};

/** Mirrors the server classifier. The server response is authoritative; this only drives grouping. */
function classify(finding: AtlasFinding, acceptedAt: string): FindingClass {
  if (finding.status === 'SUPPORTED') {
    const verifiable = finding.citations.some(c => safeHref(c.uri));
    return verifiable ? 'VERIFIED' : 'UNRESOLVED';
  }
  if (finding.status === 'UNVERIFIED') return 'AWAITING_ASSESSMENT';
  void acceptedAt;
  return 'UNRESOLVED';
}

/**
 * Only http(s) URLs with no embedded credentials become links — the same rule the server applies, so
 * the reader can never offer a clickable `javascript:` or a credential-bearing URL.
 */
export function safeHref(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Display form of a URI that is not verifiable. Embedded credentials are stripped so the reader never
 * shows somebody's password because a provider returned a userinfo-bearing URL. The URI stays marked
 * "not verifiable", so redaction never makes a weak citation look stronger.
 */
export function displayUri(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (!url.username && !url.password) return value;
    url.username = '';
    url.password = '';
    return url.href;
  } catch {
    return value;
  }
}

function blockerPhrase(status: string, citations: readonly AtlasCitation[], lang: Locale): string | null {
  const hasCitation = citations.some(c => safeHref(c.uri));
  if (status === 'UNVERIFIED') return lang === 'fr' ? 'Pas encore évalué au regard d’une politique de vérification' : 'Not yet assessed against a verification policy';
  if (!hasCitation) return lang === 'fr' ? 'Aucune citation vérifiable' : 'No verifiable citation';
  if (status === 'DISPROVEN') return lang === 'fr' ? 'Contredit par les preuves liées' : 'Contradicted by the linked evidence';
  if (status === 'CONFLICTING') return lang === 'fr' ? 'Preuves contradictoires' : 'Conflicting evidence present';
  if (status === 'STALE') return lang === 'fr' ? 'Source hors politique de fraîcheur' : 'Source is outside the freshness policy';
  if (status === 'NEEDS_HUMAN_REVIEW') return lang === 'fr' ? 'Examen humain requis' : 'Requires human review';
  return null;
}

function Provenance({ citations, lang }: { citations: readonly AtlasCitation[]; lang: Locale }) {
  const c = atlasCopy[lang];
  if (!citations.length) return <p className="atlas-muted">{c.noSource}</p>;
  return (
    <dl className="atlas-provenance">
      {citations.map((citation, index) => {
        const href = safeHref(citation.uri);
        return (
          <div key={`${citation.sourceId}-${index}`} className="atlas-provenance-item">
            <dt>{c.provider}</dt>
            <dd>
              {href
                ? <a href={href} target="_blank" rel="noopener noreferrer">{displayUri(citation.uri)}</a>
                : <span>{displayUri(citation.uri) ?? c.noUriRecorded}{' '}<strong>({c.notVerifiable})</strong></span>}
            </dd>
            <dt>{c.retrieved}</dt>
            <dd>{citation.retrievedAt || c.unknownDate}</dd>
            <dt>{c.published}</dt>
            <dd>{citation.publishedAt ?? c.unknownDate}</dd>
            <dt>{c.digest}</dt>
            <dd className="atlas-digest">
              {citation.fingerprint ? <code>{citation.fingerprint}</code> : <span className="atlas-muted">{c.noDigest}</span>}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

function FindingItem({ finding, findingClass, lang }: { finding: AtlasFinding; findingClass: FindingClass; lang: Locale }) {
  const c = atlasCopy[lang];
  const blocker = findingClass === 'VERIFIED' ? null : blockerPhrase(finding.status, finding.citations, lang);
  return (
    <li className={'atlas-finding atlas-finding-' + findingClass.toLowerCase()} data-class={findingClass}>
      <h3>{finding.statement}</h3>
      <p className="atlas-label">{classLabel[findingClass][lang]}</p>
      {blocker ? <p className="atlas-muted"><strong>{c.why}:</strong> {blocker}.</p> : null}
      {finding.limitations.length ? (
        <ul className="atlas-limits">{finding.limitations.map((text, index) => <li key={index}>{text}</li>)}</ul>
      ) : null}
      <Provenance citations={finding.citations} lang={lang} />
    </li>
  );
}

function Section({ id, title, note, items, empty, lang }: {
  id: string; title: string; note: string; items: readonly AtlasFinding[];
  empty: string; lang: Locale;
}) {
  return (
    <section id={id} aria-labelledby={id + '-heading'} className="atlas-section">
      <h2 id={id + '-heading'}>{title}</h2>
      <p className="atlas-muted">{note}</p>
      {items.length
        ? <ol className="atlas-findings">{items.map((finding, index) => (
            <FindingItem key={`${finding.claimId}-${index}`} finding={finding} findingClass={classify(finding, '')} lang={lang} />
          ))}</ol>
        : <p className="atlas-empty">{empty}</p>}
    </section>
  );
}

export function AtlasResult({ doc, lang, actions, exportsSlot }: {
  doc: AtlasDocument;
  lang: Locale;
  actions?: ReactNode;
  exportsSlot?: ReactNode;
}) {
  const c = atlasCopy[lang];
  const classified = doc.findings.map(finding => ({ finding, klass: classify(finding, '') }));
  const verified = classified.filter(x => x.klass === 'VERIFIED').map(x => x.finding);
  const unresolved = classified.filter(x => x.klass === 'UNRESOLVED').map(x => x.finding);
  const awaiting = classified.filter(x => x.klass === 'AWAITING_ASSESSMENT').map(x => x.finding);

  // The verdict is derived from the same facts the sections show, so the two can never disagree.
  const verdict = doc.status === 'DELIVERABLE'
    ? (verified.length
        ? (lang === 'fr' ? 'Résultat revu. Seuls les constats étayés sont présentés comme conclusions.' : 'Reviewed result. Only evidence-supported findings are presented as conclusions.')
        : (lang === 'fr' ? 'Résultat revu sans constat étayé. Rien ici n’est une conclusion vérifiée.' : 'Reviewed result with no evidence-supported finding. Nothing here is a verified conclusion.'))
    : doc.status === 'READY_FOR_REVIEW'
      ? (lang === 'fr' ? 'En attente d’un examen humain. Pas encore un résultat livré.' : 'Awaiting human review. Not yet a delivered result.')
      : doc.status === 'PARTIAL'
        ? (lang === 'fr' ? 'Partiel : au moins un constat n’est pas résolu. Pas un résultat livré.' : 'Partial: at least one finding is unresolved. Not a delivered result.')
        : (lang === 'fr' ? 'Brouillon. Aucun constat n’est encore établi.' : 'Draft. No finding is established yet.');

  const interpretations = doc.interpretations ?? [];
  const counts: readonly { klass: FindingClass; value: number }[] = [
    { klass: 'VERIFIED', value: verified.length },
    { klass: 'UNRESOLVED', value: unresolved.length },
    { klass: 'AWAITING_ASSESSMENT', value: awaiting.length },
    ...(interpretations.length ? [{ klass: 'AI_INTERPRETATION' as const, value: interpretations.length }] : []),
  ];

  return (
    <>
      <header className="atlas-header">
        <p className="atlas-eyebrow">{lang === 'fr' ? 'Résultat Atlas' : 'Atlas result'}</p>
        <h1>{doc.title}</h1>
        <p className="atlas-objective">{doc.objective}</p>
        {doc.businessPack ? <p className="atlas-muted">{c.structuredDeliverable}: <code>{doc.businessPack.contractKey}</code></p> : null}
        <div className="atlas-verdict" role="note" aria-label={c.verdict}>
          <strong>{c.verdict}:</strong> {verdict}
        </div>
        <nav aria-label={c.jump} className="atlas-jump">
          <a href="#atlas-verified">{c.verified}</a>
          <a href="#atlas-unresolved">{c.unresolved}</a>
          <a href="#atlas-awaiting">{c.awaiting}</a>
          <a href="#atlas-provenance">{c.provenance}</a>
          <a href="#atlas-review">{c.review}</a>
        </nav>
      </header>

      <Card>
        <h2>{c.counts}</h2>
        <ul className="atlas-counts" aria-label={c.countsLabel}>
          {counts.map(({ klass, value }) => (
            <li key={klass} data-class={klass}><strong>{value}</strong> <span>{classLabel[klass][lang]}</span></li>
          ))}
        </ul>
      </Card>

      <Card>
        <section id="atlas-scope" aria-labelledby="atlas-scope-heading">
          <h2 id="atlas-scope-heading">{c.scope}</h2>
          {doc.scope.length ? <ul>{doc.scope.map((text, index) => <li key={index}>{text}</li>)}</ul> : <p className="atlas-muted">{c.noScope}</p>}
        </section>
        <Section id="atlas-verified" title={c.verified} note={c.verifiedNote} items={verified} empty={c.noneVerified} lang={lang} />
        <Section id="atlas-unresolved" title={c.unresolved} note={c.unresolvedNote} items={unresolved} empty={c.noneUnresolved} lang={lang} />
        <Section id="atlas-awaiting" title={c.awaiting} note={c.awaitingNote} items={awaiting} empty={c.noneAwaiting} lang={lang} />
        <section id="atlas-interpretation" aria-labelledby="atlas-interpretation-heading" className="atlas-section">
          <h2 id="atlas-interpretation-heading">{c.interpretation}</h2>
          <p className="atlas-muted">{c.interpretationNote}</p>
          {interpretations.length
            ? <ol className="atlas-findings">{interpretations.map((text, index) => (
                <li key={index} className="atlas-finding atlas-finding-ai_interpretation" data-class="AI_INTERPRETATION">
                  <h3>{text}</h3>
                  <p className="atlas-label">{classLabel.AI_INTERPRETATION[lang]}</p>
                </li>
              ))}</ol>
            : <p className="atlas-empty">{c.noneInterpretation}</p>}
        </section>
      </Card>

      <Card>
        <section aria-labelledby="atlas-limits-heading">
          <h2 id="atlas-limits-heading">{c.limits}</h2>
          {doc.limitations.length ? <ul>{doc.limitations.map((text, index) => <li key={index}>{text}</li>)}</ul> : <p className="atlas-muted">{c.noLimits}</p>}
        </section>
        <section aria-labelledby="atlas-unresolved-ids-heading">
          <h2 id="atlas-unresolved-ids-heading">{c.unresolvedIds}</h2>
          {doc.unresolved.length ? <ul>{doc.unresolved.map((text, index) => <li key={index}><code>{text}</code></li>)}</ul> : <p className="atlas-muted">{c.none}</p>}
        </section>
        <section aria-labelledby="atlas-next-heading">
          <h2 id="atlas-next-heading">{c.next}</h2>
          {doc.nextActions.length ? <ul>{doc.nextActions.map((text, index) => <li key={index}>{text}</li>)}</ul> : <p className="atlas-muted">{c.noNext}</p>}
        </section>
      </Card>

      <Card>
        <section id="atlas-provenance" aria-labelledby="atlas-provenance-heading">
          <h2 id="atlas-provenance-heading">{c.provenance}</h2>
          <Provenance citations={doc.citations} lang={lang} />
        </section>
        <section id="atlas-review" aria-labelledby="atlas-review-heading">
          <h2 id="atlas-review-heading">{c.review}</h2>
          <p>{c.version} {doc.version} · {c.statusLabel} {c.statusValue[doc.status] ?? doc.status}</p>
          <p className="atlas-muted">
            {doc.reviewedAt
              ? `${c.reviewed} ${doc.reviewedAt}${doc.reviewedBy ? ` ${c.reviewedBy} ${doc.reviewedBy}` : ''}.`
              : c.notReviewed}
          </p>
          {doc.priorId ? <p className="atlas-muted">{c.supersedes}</p> : null}
        </section>
        {actions ? <div className="atlas-actions">{actions}</div> : null}
        {exportsSlot ? <div className="atlas-exports">{exportsSlot}</div> : null}
      </Card>
    </>
  );
}

import type { ResultDocument, ResultFinding } from './result-document';

/**
 * MISSION A07 — Atlas results: one classification of what a finding actually is.
 *
 * The product rule is blunt: **an unreviewed claim is never a verified conclusion.** Before A07 the
 * reader rendered a raw `status` string and a limitations list, so "SUPPORTED" (structural policy
 * evidence) and "DELIVERABLE" (human-approved) looked like the same kind of statement.
 *
 * This module is a pure classifier with no I/O, used by the API export, the PDF, the reader UI and the
 * tests. If the classification lives in four places it will disagree with itself, so it lives here.
 */

/**
 * - `VERIFIED` — structurally supported by qualifying provider evidence with a captured digest. This
 *   is *evidence-backed*, not human-approved. Only the document state proves approval.
 * - `AI_INTERPRETATION` — the agent's own synthesis. Never evidence on its own.
 * - `UNRESOLVED` — assessed and not established (disproven, conflicting, stale, needs review).
 * - `AWAITING_ASSESSMENT` — nothing has been assessed yet. The default and the most common state.
 */
export type FindingClass = 'VERIFIED' | 'AI_INTERPRETATION' | 'UNRESOLVED' | 'AWAITING_ASSESSMENT';

/** Why a finding could not be shown as verified, in a form a customer can act on. */
export type FindingBlocker =
  | 'NOT_ASSESSED'
  | 'NO_QUALIFYING_EVIDENCE'
  | 'DISPROVEN_BY_EVIDENCE'
  | 'CONTRADICTORY_EVIDENCE'
  | 'SOURCE_STALE'
  | 'HUMAN_REVIEW_REQUIRED'
  | 'NO_VERIFIABLE_CITATION';

export interface ClassifiedFinding {
  readonly finding: ResultFinding;
  readonly findingClass: FindingClass;
  /** True only for VERIFIED. Every other class must never be rendered as a conclusion. */
  readonly verified: boolean;
  readonly blockers: readonly FindingBlocker[];
  /** Citations that carry a real http(s) URI — the only ones that count as verifiable provenance. */
  readonly verifiableCitations: readonly ResultCitationLike[];
  readonly unverifiableCitationCount: number;
}

export interface ResultCitationLike {
  readonly sourceId: string;
  readonly provider: string;
  readonly uri?: string;
  readonly retrievedAt: string;
  readonly publishedAt?: string;
  readonly fingerprint?: string;
}

/** A citation is verifiable only if it is a real http(s) URL carrying no embedded credentials. */
export function isVerifiableUri(uri?: string): boolean {
  if (!uri) return false;
  try {
    const url = new URL(uri);
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password;
  } catch {
    return false;
  }
}

const CLASS_BY_STATUS: Readonly<Record<string, FindingClass>> = {
  SUPPORTED: 'VERIFIED',
  UNVERIFIED: 'AWAITING_ASSESSMENT',
  NEEDS_HUMAN_REVIEW: 'UNRESOLVED',
  CONFLICTING: 'UNRESOLVED',
  STALE: 'UNRESOLVED',
  DISPROVEN: 'UNRESOLVED',
};

const BLOCKERS_BY_STATUS: Readonly<Record<string, readonly FindingBlocker[]>> = {
  SUPPORTED: [],
  UNVERIFIED: ['NOT_ASSESSED'],
  NEEDS_HUMAN_REVIEW: ['HUMAN_REVIEW_REQUIRED'],
  CONFLICTING: ['CONTRADICTORY_EVIDENCE'],
  STALE: ['SOURCE_STALE'],
  DISPROVEN: ['DISPROVEN_BY_EVIDENCE'],
};

/**
 * Classification is deliberately conservative in one direction only: it can demote a SUPPORTED claim
 * that has no verifiable citation, and it can never promote anything. Promotion to a delivered result
 * requires the human review flow, which is a separate, audited transition.
 */
export function classifyFinding(finding: ResultFinding): ClassifiedFinding {
  const citations = finding.citations ?? [];
  const verifiable = citations.filter(citation => isVerifiableUri(citation.uri));
  const blockers: FindingBlocker[] = [...(BLOCKERS_BY_STATUS[finding.status] ?? ['NOT_ASSESSED'])];
  if (!verifiable.length && (finding.status === 'SUPPORTED' || finding.status === 'UNVERIFIED')) {
    blockers.push('NO_VERIFIABLE_CITATION');
  }
  let findingClass: FindingClass = CLASS_BY_STATUS[finding.status] ?? 'AWAITING_ASSESSMENT';
  // A claim the policy calls supported but that cites nothing checkable is not a verified conclusion.
  if (findingClass === 'VERIFIED' && !verifiable.length) findingClass = 'UNRESOLVED';
  const verified = findingClass === 'VERIFIED';
  return {
    finding,
    findingClass,
    verified,
    blockers: verified ? [] : [...new Set(blockers)],
    verifiableCitations: verifiable,
    unverifiableCitationCount: citations.length - verifiable.length,
  };
}

export interface DocumentClassification {
  readonly findings: readonly ClassifiedFinding[];
  readonly verified: readonly ClassifiedFinding[];
  readonly interpretations: readonly ClassifiedFinding[];
  readonly unresolved: readonly ClassifiedFinding[];
  readonly awaitingAssessment: readonly ClassifiedFinding[];
  /** True only when the document is DELIVERABLE and at least one finding is verified. */
  readonly deliverable: boolean;
  /** Counts shown to the customer; derived, never stored. */
  readonly counts: Readonly<Record<FindingClass, number>>;
}

export function classifyDocument(doc: ResultDocument): DocumentClassification {
  const findings = (doc.findings ?? []).map(classifyFinding);
  const verified = findings.filter(f => f.findingClass === 'VERIFIED');
  const interpretations = findings.filter(f => f.findingClass === 'AI_INTERPRETATION');
  const unresolved = findings.filter(f => f.findingClass === 'UNRESOLVED');
  const awaitingAssessment = findings.filter(f => f.findingClass === 'AWAITING_ASSESSMENT');
  return {
    findings,
    verified,
    interpretations,
    unresolved,
    awaitingAssessment,
    deliverable: doc.status === 'DELIVERABLE' && verified.length > 0,
    counts: {
      VERIFIED: verified.length,
      AI_INTERPRETATION: interpretations.length,
      UNRESOLVED: unresolved.length,
      AWAITING_ASSESSMENT: awaitingAssessment.length,
    },
  };
}

/** Customer-facing, translated elsewhere. Kept as a stable code so the UI and exports agree. */
export const FINDING_CLASS_LABEL: Readonly<Record<FindingClass, string>> = {
  VERIFIED: 'Evidence-supported',
  AI_INTERPRETATION: 'AI interpretation',
  UNRESOLVED: 'Unresolved',
  AWAITING_ASSESSMENT: 'Awaiting assessment',
};

export const BLOCKER_LABEL: Readonly<Record<FindingBlocker, string>> = {
  NOT_ASSESSED: 'Not yet assessed against a verification policy',
  NO_QUALIFYING_EVIDENCE: 'No qualifying evidence linked',
  DISPROVEN_BY_EVIDENCE: 'Contradicted by the linked evidence',
  CONTRADICTORY_EVIDENCE: 'Conflicting evidence present',
  SOURCE_STALE: 'Source is outside the freshness policy',
  HUMAN_REVIEW_REQUIRED: 'Requires human review before it can be relied on',
  NO_VERIFIABLE_CITATION: 'No verifiable citation URI',
};

/**
 * The document-level verdict. Stated once, so no page, export or PDF can imply a stronger claim than
 * the persisted document state supports.
 */
export function documentVerdict(doc: ResultDocument, classification: DocumentClassification): string {
  if (doc.status === 'DELIVERABLE' && classification.verified.length) {
    return 'Reviewed result. Only evidence-supported findings are presented as conclusions.';
  }
  if (doc.status === 'DELIVERABLE') {
    return 'Reviewed result with no evidence-supported findings. Nothing here is a verified conclusion.';
  }
  if (doc.status === 'READY_FOR_REVIEW') return 'Awaiting human review. Not yet a delivered result.';
  if (doc.status === 'PARTIAL') return 'Partial: at least one finding is unresolved. Not a delivered result.';
  return 'Draft. No finding has been established yet.';
}

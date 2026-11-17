import type { Locale } from '../../lib/copy';

/** Presentation-only types for Flow 2.0. They are derived from existing API reads in lib/flow-model.ts. */
export type FlowStatus = 'available' | 'empty' | 'loading' | 'denied' | 'error' | 'stale';
export interface FlowReadState { status: FlowStatus; code?: string }

export type FlowConsentState = 'granted' | 'not_granted' | 'unavailable';
export interface FlowConsent { state: FlowConsentState; code?: string }

export interface FlowObjective { statement: string | null; constraints: readonly string[] }

export interface FlowAttempt {
  attemptId: string;
  sequence: number;
  state: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  errorCode: string | null;
}

export interface FlowDependency { id: string; title: string; ordinal: number }

export interface FlowStep {
  id: string;
  ordinal: number;
  title: string;
  description: string;
  state: string;
  intent: string;
  capabilityId: string;
  capabilityName: string;
  capabilityPurpose: string;
  capabilityExternalActions: boolean;
  capabilityActive: boolean;
  dependsOn: FlowDependency[];
  latestAttempt: FlowAttempt | null;
  attempts: FlowAttempt[];
  attemptCount: number;
}

export interface FlowApproval {
  id: string;
  purpose: string;
  status: string;
  requestedAt: string;
  expiresAt: string;
  stale: boolean;
  attemptId: string;
  pending: boolean;
}

export interface FlowAgent {
  id: string;
  capabilityId: string;
  capabilityName: string;
  capabilityPurpose: string;
  capabilityExternalActions: boolean;
  stepId: string;
  stepTitle: string;
  stepState: string;
  attemptSequence: number | null;
  attemptState: string | null;
  startedAt: string | null;
  waitingApproval: boolean;
}

export interface FlowEvent {
  id: string;
  eventId: string;
  sequence: number;
  kind: string;
  occurredAt: string;
}

export interface FlowEvents {
  state: FlowReadState;
  items: FlowEvent[];
  duplicates: number;
  nextCursor: number | null;
  moreHref: string | null;
}

export interface FlowDocumentSummary {
  id: string;
  title: string;
  status: string;
  version: number;
  createdAt: string;
  href: string;
  findings: { claimId: string; statement: string; status: string; citations: { sourceId: string; provider: string }[] }[];
  limitations: string[];
}

export interface FlowDocuments {
  state: FlowReadState;
  items: FlowDocumentSummary[];
  delivered: boolean;
  reviewReady: boolean;
}

export interface FlowClaims {
  state: FlowReadState;
  count: number;
  supported: number;
  unverified: number;
  needsReview: boolean;
}

export interface FlowPilot { state: FlowReadState; action: string | null; reason: string | null }

export interface FlowSummary {
  state: FlowReadState;
  stepCount: number | null;
  completedSteps: number | null;
  pendingApprovals: number | null;
  lastSequence: number | null;
}

export interface FlowReadiness {
  state: FlowReadState;
  canStart: boolean;
  blockers: number;
  planPresent: boolean;
  costKnown: boolean;
}

export interface FlowContextFact { id: string; key: string; value: string; updatedAt: string }
export interface FlowContext {
  facts: FlowContextFact[];
  factsState: FlowReadState;
  consent: FlowConsent;
}

export type FlowPhaseId = 'FRAME' | 'EXECUTE' | 'REVIEW' | 'RESULT';
export type FlowPhaseState = 'complete' | 'active' | 'pending' | 'blocked' | 'stopped' | 'unknown';

export interface FlowPhase {
  id: FlowPhaseId;
  state: FlowPhaseState;
  completedSteps: number;
  totalSteps: number;
  pendingApprovals: number;
  documentCount: number;
  resultStatus: string | null;
  steps: FlowStep[];
}

export type FlowNowKind = 'approval' | 'running' | 'interruption' | 'preparation' | 'recovery' | 'result' | 'idle';

export interface FlowNow {
  kind: FlowNowKind;
  activeStep: FlowStep | null;
  activeAgent: FlowAgent | null;
  approval: FlowApproval | null;
  document: FlowDocumentSummary | null;
  progress: { completed: number; total: number } | null;
  readiness: FlowReadiness;
  resultCount: number;
}

export interface FlowGates {
  interrupt: boolean;
  redo: boolean;
  editPlan: boolean;
  decideApproval: boolean;
}

export interface FlowReadEntry { id: string; state: FlowReadState }

export interface FlowModel {
  operation: { id: string; title: string; status: string; version: number; lastActivityAt: string; lastErrorCode: string | null };
  planRevision: number | null;
  objective: FlowObjective;
  phases: FlowPhase[];
  steps: FlowStep[];
  approvals: FlowApproval[];
  pendingApprovals: FlowApproval[];
  agents: FlowAgent[];
  events: FlowEvents;
  documents: FlowDocuments;
  claims: FlowClaims;
  pilot: FlowPilot;
  summary: FlowSummary;
  readiness: FlowReadiness;
  context: FlowContext;
  now: FlowNow;
  gates: FlowGates;
  staleReads: string[];
  readStates: FlowReadEntry[];
}

export type FlowSelectionKind = 'step' | 'agent' | 'event' | 'approval';
export interface FlowSelection { kind: FlowSelectionKind; id: string }

export type FlowLocale = Locale;

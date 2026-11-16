import 'server-only';
import { z } from 'zod';
import type { Locale } from './copy';
import { claimListSchema, commercialViewSchema, planViewSchema, readinessSchema } from './plan';
import { activitySchema, contextSchema, documentSchema, guidanceSchema, summarySchema } from './mission';
import type {
  FlowAgent, FlowApproval, FlowAttempt, FlowClaims, FlowConsent, FlowContext, FlowDocumentSummary,
  FlowDocuments, FlowEvent, FlowEvents, FlowModel, FlowObjective, FlowPhase, FlowPhaseState, FlowPilot,
  FlowReadEntry, FlowReadState, FlowReadiness, FlowStep, FlowSummary,
} from '../components/flow/types';

type PlanView = z.infer<typeof planViewSchema>;
type Readiness = z.infer<typeof readinessSchema>;
type Summary = z.infer<typeof summarySchema>;
type Activity = z.infer<typeof activitySchema>;
type Guidance = z.infer<typeof guidanceSchema>;
type CommercialView = z.infer<typeof commercialViewSchema>;
type ClaimView = z.infer<typeof claimListSchema>[number];
type ResultDocument = z.infer<typeof documentSchema>;
type Fact = z.infer<typeof contextSchema>[number];

export type FlowReadResult<T> = { data: T; code?: never } | { data?: never; code: string };

/** Maps an existing validated read to a truthful availability state. A failure is never an empty list. */
export function readState<T>(result: FlowReadResult<T>, options: { stale?: boolean; empty?: boolean } = {}): FlowReadState {
  if (options.stale) return { status: 'stale', code: 'STALE' };
  if (result.data === undefined) {
    const code = result.code ?? 'INVALID_RESPONSE';
    if (code === 'DENIED' || code === 'SESSION_REQUIRED') return { status: 'denied', code };
    return { status: 'error', code };
  }
  if (options.empty) return { status: 'empty' };
  return { status: 'available' };
}

/** Keeps availability truthful when a read succeeded but its operation identity/version did not match. */
export function stateOf<T>(result: FlowReadResult<T>, valid: T | null, options: { stale?: boolean; empty?: boolean } = {}): FlowReadState {
  if (result.data === undefined) return readState(result, options);
  if (valid === null) return { status: 'error', code: 'INVALID_RESPONSE' };
  return readState(result, options);
}

export interface FlowModelInput {
  lang: Locale;
  cursor: number;
  pageSize: number;
  operation: { id: string; title: string; status: string; version: number; lastActivityAt: string; lastErrorCode: string | null };
  plan: PlanView | null;
  planState: FlowReadState;
  readiness: Readiness | null;
  readinessState: FlowReadState;
  summary: Summary | null;
  summaryState: FlowReadState;
  activity: Activity | null;
  activityState: FlowReadState;
  pilot: Guidance | null;
  pilotState: FlowReadState;
  commercial: CommercialView | null;
  commercialState: FlowReadState;
  claims: ClaimView[] | null;
  claimsState: FlowReadState;
  documents: ResultDocument[] | null;
  documentsState: FlowReadState;
  facts: Fact[] | null;
  factsState: FlowReadState;
  consent: FlowConsent;
}

const ACTIVE_STATES = new Set(['RUNNING', 'WAITING_APPROVAL']);
const STARTED_STATUSES = new Set(['RUNNING', 'WAITING_APPROVAL', 'INTERRUPT_REQUESTED', 'INTERRUPTED', 'FAILED', 'COMPLETED']);

function attemptsFor(plan: PlanView | null): Map<string, FlowAttempt[]> {
  const grouped = new Map<string, FlowAttempt[]>();
  for (const attempt of plan?.attempts ?? []) {
    const mapped: FlowAttempt = {
      attemptId: attempt.attemptId, sequence: attempt.sequence, state: attempt.state,
      createdAt: attempt.createdAt, startedAt: attempt.startedAt, finishedAt: attempt.finishedAt,
      errorCode: attempt.errorCode,
    };
    const list = grouped.get(attempt.stepId);
    if (list) list.push(mapped);
    else grouped.set(attempt.stepId, [mapped]);
  }
  for (const list of grouped.values()) list.sort((left, right) => right.sequence - left.sequence);
  return grouped;
}

function mapSteps(plan: PlanView | null): FlowStep[] {
  if (!plan) return [];
  const capabilities = new Map(plan.capabilities.map(capability => [capability.id, capability]));
  const attempts = attemptsFor(plan);
  const byId = new Map(plan.steps.map(step => [step.id, step]));
  return [...plan.steps].sort((left, right) => left.ordinal - right.ordinal).map(step => {
    const capability = capabilities.get(step.capabilityId);
    const history = attempts.get(step.id) ?? [];
    return {
      id: step.id,
      ordinal: step.ordinal,
      title: step.title,
      description: step.description,
      state: step.state,
      intent: step.intent,
      capabilityId: step.capabilityId,
      capabilityName: capability?.name ?? step.capabilityId,
      capabilityPurpose: capability?.purpose ?? '',
      capabilityExternalActions: capability?.externalActions ?? false,
      capabilityActive: step.capabilityActive,
      dependsOn: step.dependsOn.map(dependencyId => {
        const dependency = byId.get(dependencyId);
        return { id: dependencyId, title: dependency?.title ?? dependencyId, ordinal: dependency?.ordinal ?? 0 };
      }),
      latestAttempt: history[0] ?? null,
      attempts: history,
      attemptCount: history.length,
    };
  });
}

function mapAgents(steps: FlowStep[]): FlowAgent[] {
  const agents: FlowAgent[] = [];
  for (const step of steps) {
    const activeAttempt = step.attempts.find(attempt => ACTIVE_STATES.has(attempt.state)) ?? null;
    const activeStep = ACTIVE_STATES.has(step.state);
    if (!activeAttempt && !activeStep) continue;
    if (!step.capabilityActive) continue;
    agents.push({
      id: step.id,
      capabilityId: step.capabilityId,
      capabilityName: step.capabilityName,
      capabilityPurpose: step.capabilityPurpose,
      capabilityExternalActions: step.capabilityExternalActions,
      stepId: step.id,
      stepTitle: step.title,
      stepState: step.state,
      attemptSequence: activeAttempt?.sequence ?? null,
      attemptState: activeAttempt?.state ?? null,
      startedAt: activeAttempt?.startedAt ?? null,
      waitingApproval: activeAttempt?.state === 'WAITING_APPROVAL' || step.state === 'WAITING_APPROVAL',
    });
  }
  return agents;
}

function mapApprovals(plan: PlanView | null, stale: boolean): FlowApproval[] {
  return (plan?.approvals ?? []).map(approval => ({
    id: approval.id,
    purpose: approval.purpose,
    status: approval.status,
    requestedAt: approval.requestedAt,
    expiresAt: approval.expiresAt,
    stale: approval.stale,
    attemptId: approval.stepAttemptId,
    pending: approval.status === 'PENDING' && !approval.stale && !stale,
  }));
}

function mapEvents(input: FlowModelInput): FlowEvents {
  if (!input.activity) return { state: input.activityState, items: [], duplicates: 0, nextCursor: null, moreHref: null };
  const seen = new Set<string>();
  const deduped: FlowEvent[] = [];
  let duplicates = 0;
  for (const event of input.activity.events) {
    if (seen.has(event.eventId)) { duplicates += 1; continue; }
    seen.add(event.eventId);
    deduped.push({ id: event.id, eventId: event.eventId, sequence: event.sequence, kind: event.kind, occurredAt: event.occurredAt });
  }
  deduped.sort((left, right) => left.sequence - right.sequence);
  const nextCursor = input.activity.events.length === input.pageSize && input.activity.nextCursor > input.cursor ? input.activity.nextCursor : null;
  return {
    state: input.activityState,
    items: deduped.reverse(),
    duplicates,
    nextCursor,
    moreHref: nextCursor === null ? null : '/' + input.lang + '/missions/' + input.operation.id + '?after=' + nextCursor,
  };
}

function documentWeight(status: string): number {
  return status === 'DELIVERABLE' ? 3 : status === 'READY_FOR_REVIEW' ? 2 : status === 'PARTIAL' ? 1 : 0;
}

function mapDocuments(input: FlowModelInput): { documents: FlowDocuments; items: FlowDocumentSummary[]; delivered: boolean; reviewReady: boolean } {
  const scoped = (input.documents ?? []).filter(document => document.operationId === input.operation.id);
  const items: FlowDocumentSummary[] = scoped.map(document => ({
    id: document.id, title: document.title, status: document.status, version: document.version,
    createdAt: document.createdAt,
    href: '/' + input.lang + '/missions/' + input.operation.id + '/results/' + encodeURIComponent(document.id),
  })).sort((left, right) => (documentWeight(right.status) - documentWeight(left.status)) || right.version - left.version);
  const delivered = items.some(item => item.status === 'DELIVERABLE');
  const reviewReady = items.some(item => item.status === 'READY_FOR_REVIEW');
  const state: FlowReadState = input.documentsState.status === 'available' && items.length === 0 ? { status: 'empty' } : input.documentsState;
  return { documents: { state, items, delivered, reviewReady }, items, delivered, reviewReady };
}

function mapClaims(input: FlowModelInput): FlowClaims {
  const items = input.claims ?? [];
  const supported = items.filter(claim => claim.status === 'SUPPORTED').length;
  const unverified = items.filter(claim => claim.status === 'UNVERIFIED').length;
  const state: FlowReadState = input.claimsState.status === 'available' && items.length === 0 ? { status: 'empty' } : input.claimsState;
  return { state, count: items.length, supported, unverified, needsReview: items.length > 0 && unverified > 0 };
}

function mapReadiness(input: FlowModelInput): FlowReadiness {
  const data = input.readiness;
  return {
    state: input.readinessState,
    canStart: Boolean(data?.canStart) && input.readinessState.status !== 'stale' && input.readinessState.status !== 'error' && input.readinessState.status !== 'denied',
    blockers: data?.blockers.length ?? 0,
    planPresent: data?.plan.present ?? false,
    costKnown: data?.cost.known ?? false,
  };
}

function mapSummary(input: FlowModelInput): FlowSummary {
  const data = input.summary;
  return {
    state: input.summaryState,
    stepCount: data?.stepCount ?? null,
    completedSteps: data?.completedSteps ?? null,
    pendingApprovals: data?.pendingApprovals ?? null,
    lastSequence: data?.lastSequence ?? null,
  };
}

function mapContext(input: FlowModelInput): FlowContext {
  const facts = (input.facts ?? []).map(fact => {
    let value = '';
    try {
      value = typeof fact.value === 'string' ? fact.value : fact.value === null ? '' : JSON.stringify(fact.value);
    } catch { value = ''; }
    return { id: fact.id, key: fact.key, value: value.length > 400 ? value.slice(0, 400) + '…' : value, updatedAt: fact.updatedAt };
  });
  return { facts, factsState: input.factsState, consent: input.consent };
}

function phase(id: FlowPhase['id'], state: FlowPhaseState, extra: Partial<FlowPhase> = {}): FlowPhase {
  return { id, state, completedSteps: 0, totalSteps: 0, pendingApprovals: 0, documentCount: 0, resultStatus: null, steps: [], ...extra };
}

function mapPhases(input: FlowModelInput, steps: FlowStep[], pendingApprovals: FlowApproval[], documents: FlowDocuments, claims: FlowClaims, readiness: FlowReadiness): FlowPhase[] {
  const total = steps.length;
  const completed = steps.filter(step => step.state === 'COMPLETED').length;
  const planUnknown = input.planState.status === 'error' || input.planState.status === 'denied' || input.planState.status === 'stale';
  const anyActive = steps.some(step => ACTIVE_STATES.has(step.state) || step.attempts.some(attempt => ACTIVE_STATES.has(attempt.state)));
  const anyFailed = steps.some(step => step.state === 'FAILED');
  const latestDocument = documents.items[0] ?? null;

  let frame: FlowPhaseState;
  if (planUnknown) frame = 'unknown';
  else if (!input.plan || total === 0) frame = 'pending';
  else if (STARTED_STATUSES.has(input.operation.status)) frame = 'complete';
  else if (readiness.state.status === 'stale' || readiness.state.status === 'error' || readiness.state.status === 'denied') frame = 'unknown';
  else if (readiness.canStart) frame = 'active';
  else frame = 'blocked';

  let execute: FlowPhaseState;
  if (planUnknown) execute = 'unknown';
  else if (!input.plan || total === 0) execute = 'pending';
  else if (anyActive) execute = 'active';
  else if (input.operation.status === 'INTERRUPTED' || input.operation.status === 'INTERRUPT_REQUESTED') execute = 'stopped';
  else if (input.operation.status === 'FAILED' || anyFailed) execute = 'blocked';
  else if (input.operation.status === 'COMPLETED' || (total > 0 && completed === total)) execute = 'complete';
  else if (!STARTED_STATUSES.has(input.operation.status)) execute = 'pending';
  else execute = 'pending';

  let review: FlowPhaseState;
  if (planUnknown) review = 'unknown';
  else if (documents.delivered) review = 'complete';
  else if (pendingApprovals.length > 0) review = 'active';
  else if (claims.state.status === 'denied' || claims.state.status === 'error') review = 'unknown';
  else if (claims.state.status === 'available' && claims.count > 0 && claims.unverified === 0) review = 'complete';
  else if (claims.state.status === 'available' && claims.needsReview && (input.operation.status === 'WAITING_APPROVAL' || input.operation.status === 'RUNNING')) review = 'active';
  else if (claims.count > 0 && claims.needsReview) review = 'pending';
  else review = 'pending';

  let result: FlowPhaseState;
  if (documents.state.status === 'denied' || documents.state.status === 'error') result = 'unknown';
  else if (documents.items.length === 0) result = input.operation.status === 'COMPLETED' ? 'unknown' : 'pending';
  else if (documents.delivered) result = 'complete';
  else result = 'active';

  return [
    phase('FRAME', frame, { completedSteps: completed, totalSteps: total, pendingApprovals: pendingApprovals.length, documentCount: documents.items.length, resultStatus: latestDocument?.status ?? null }),
    phase('EXECUTE', execute, { completedSteps: completed, totalSteps: total, pendingApprovals: pendingApprovals.length, documentCount: documents.items.length, resultStatus: latestDocument?.status ?? null, steps }),
    phase('REVIEW', review, { completedSteps: completed, totalSteps: total, pendingApprovals: pendingApprovals.length, documentCount: documents.items.length, resultStatus: latestDocument?.status ?? null }),
    phase('RESULT', result, { completedSteps: completed, totalSteps: total, pendingApprovals: pendingApprovals.length, documentCount: documents.items.length, resultStatus: latestDocument?.status ?? null }),
  ];
}

function mapNow(
  input: FlowModelInput, steps: FlowStep[], agents: FlowAgent[], pendingApprovals: FlowApproval[],
  documents: FlowDocuments, readiness: FlowReadiness, summary: FlowSummary,
): FlowModel['now'] {
  const status = input.operation.status;
  const activeAgent = agents[0] ?? null;
  const activeStep = activeAgent ? steps.find(step => step.id === activeAgent.stepId) ?? null : steps.find(step => ACTIVE_STATES.has(step.state)) ?? null;
  const approval = pendingApprovals[0] ?? null;
  const document = documents.items[0] ?? null;
  const progress = summary.state.status === 'available' && summary.stepCount !== null && summary.completedSteps !== null && summary.stepCount > 0
    ? { completed: Math.min(summary.completedSteps, summary.stepCount), total: summary.stepCount }
    : null;
  let kind: FlowModel['now']['kind'];
  if (status === 'WAITING_APPROVAL') kind = 'approval';
  else if (status === 'INTERRUPT_REQUESTED') kind = 'interruption';
  else if (status === 'RUNNING') kind = 'running';
  else if (status === 'INTERRUPTED' || status === 'FAILED') kind = 'recovery';
  else if (status === 'COMPLETED') kind = 'result';
  else if (status === 'DRAFT' || status === 'READY') kind = 'preparation';
  else kind = 'idle';
  return { kind, activeStep, activeAgent, approval, document, progress, readiness, resultCount: documents.items.length };
}

function mapPilot(input: FlowModelInput): FlowPilot {
  return {
    state: input.pilotState,
    action: input.pilot?.action ?? null,
    reason: input.pilot?.reason ?? null,
  };
}

export function buildFlowModel(input: FlowModelInput): FlowModel {
  const steps = mapSteps(input.plan);
  const agents = mapAgents(steps);
  const stalePlan = input.planState.status === 'stale';
  const approvals = mapApprovals(input.plan, stalePlan);
  const pendingApprovals = approvals.filter(approval => approval.pending);
  const mappedDocuments = mapDocuments(input);
  const claims = mapClaims(input);
  const readiness = mapReadiness(input);
  const summary = mapSummary(input);
  const events = mapEvents(input);
  const documents = mappedDocuments.documents;
  const context = mapContext(input);
  const phases = mapPhases(input, steps, pendingApprovals, documents, claims, readiness);
  const now = mapNow(input, steps, agents, pendingApprovals, documents, readiness, summary);
  const planReadable = input.plan !== null && !stalePlan;

  const objective: FlowObjective = {
    statement: input.plan?.goal?.statement ?? null,
    constraints: input.plan?.goal?.constraints ?? [],
  };

  const readStates: FlowReadEntry[] = [
    { id: 'plan', state: input.planState },
    { id: 'readiness', state: input.readinessState },
    { id: 'summary', state: input.summaryState },
    { id: 'activity', state: input.activityState },
    { id: 'pilot', state: input.pilotState },
    { id: 'commercial', state: input.commercialState },
    { id: 'claims', state: claims.state },
    { id: 'documents', state: documents.state },
    { id: 'context', state: input.factsState },
    { id: 'consents', state: input.consent.state === 'unavailable' ? { status: 'error', code: input.consent.code ?? 'UNAVAILABLE' } : { status: 'available' } },
  ];

  return {
    operation: input.operation,
    planRevision: input.plan?.revision?.revision ?? null,
    objective,
    phases,
    steps,
    approvals,
    pendingApprovals,
    agents,
    events,
    documents,
    claims,
    pilot: mapPilot(input),
    summary,
    readiness,
    context,
    now,
    gates: {
      interrupt: input.operation.status === 'RUNNING' || input.operation.status === 'WAITING_APPROVAL',
      redo: planReadable && ['READY', 'INTERRUPTED', 'FAILED', 'COMPLETED'].includes(input.operation.status),
      editPlan: planReadable && ['DRAFT', 'READY', 'INTERRUPTED', 'FAILED', 'COMPLETED'].includes(input.operation.status),
      decideApproval: !stalePlan && pendingApprovals.length > 0,
    },
    staleReads: readStates.filter(entry => entry.state.status === 'stale').map(entry => entry.id),
    readStates,
  };
}

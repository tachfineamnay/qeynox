import { createHash } from 'node:crypto';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { DomainError, type Goal, type ID, type Principal, type Source, type WorkStep } from '@qeynox/domain';
import { QeyNoxStore, attempts, evidences, sources, stepOutputs } from '@qeynox/persistence';
import {
  BUSINESS_PACK_DOMAINS,
  PACK_CONTRACT_KEYS,
  financialAnalysisPackRequestSchema,
  marketingPackRequestSchema,
  operationsPackRequestSchema,
  strategyPackRequestSchema,
  type BusinessPackDomain,
  type PackDeliverable,
} from '@qeynox/contracts';
import {
  DELIVERABLE_SECTIONS_BY_PACK,
  computeFinancialSensitivity,
  computeProcessDiagnostics,
  extractStructuredDeliverableFromJson,
  projectDeliverableToResultSummary,
  validatePackDeliverable,
  type DeliverableResultProjection,
  type DeliverableValidationContext,
} from './business-pack-deliverables';
import { packRequestFingerprint } from './business-packs';
import type { ClaimsService } from './claims';

/**
 * MISSION P09 — wire the A16 business-pack deliverables into worker execution.
 *
 * A16 shipped eight typed packs, their structured deliverable schemas, `validatePackDeliverable()`
 * and `projectDeliverableToResultSummary()`, but the worker recorded every step as one generic
 * AGENT_FINDING built from the raw answer text. This module is the only glue between them. It holds
 * no business rules of its own; every rule is the existing A16 one:
 *
 * 1. **Recover** the original validated request and pack identity from the operation goal. The
 *    recorded canonical request must hash to the fingerprint the customer approved, and its pack and
 *    contract must agree with the operation constraints. Anything else fails closed.
 * 2. **Instruct**: every step runs under the pack's own capability, and therefore its slot profile.
 *    The step gets the recovered request (`step:input`, gated by the profile) and, for the final
 *    step, the `<pack>@1` output contract with the exact source URIs that ToolBroker captured.
 * 3. **Accept**: the final step's Hermes output is parsed and validated by the existing A16
 *    validator, with context rebuilt from the recovered request (expected competitors, channels and
 *    budget, deterministic diagnostics and sensitivity, captured URIs). Invalid output is rejected
 *    with INVALID_AGENT_OUTPUT. Nothing is invented, repaired or partially kept.
 * 4. **Persist**: the existing projection becomes domain claims linked to the captured evidence that
 *    each one cites. The validated deliverable is recorded on the step output, so the canonical
 *    ResultDocument (and every later re-assembly) derives its title, scope, limitations, next
 *    actions and AI interpretation from it.
 *
 * Generic (non-pack) missions never enter this module: `recoverBusinessPackMission` returns null.
 */

export type BusinessPackStepRole = 'DELIVERABLE' | 'SUPPORTING';

export interface BusinessPackMission {
  readonly pack: BusinessPackDomain;
  readonly contractKey: string;
  readonly capabilityId: ID;
  readonly fingerprint: string;
  readonly goalStatement: string;
  /** The normalized request exactly as validated and approved (fingerprint-verified). */
  readonly request: Readonly<Record<string, unknown>>;
}

/** One ToolBroker capture of this revision, usable as a citation and as claim evidence. */
export interface CapturedPackSource {
  readonly sourceId: ID;
  readonly evidenceId: ID;
  readonly uri: string;
  readonly responseDigest: string;
  readonly provider: string;
}

/** What the worker records on the final step output. Re-validated whenever it is read. */
export interface BusinessDeliverableRecord {
  readonly pack: BusinessPackDomain;
  readonly contractKey: string;
  readonly requestFingerprint: string;
  readonly schemaVersion: 1;
  readonly deliverable: PackDeliverable;
}

/** Identity of the validated deliverable a ResultDocument was assembled from. */
export interface ResultBusinessPack {
  readonly pack: string;
  readonly contractKey: string;
  readonly requestFingerprint: string;
  readonly attemptId: ID;
}

const CLAIM_KIND_PREFIX = 'business-pack:';
const MAX_CITABLE_URIS = 100;
const REQUEST_CONTEXT_KEY = 'step:input';

function unrecoverable(reason: string): never {
  throw new DomainError('INVALID_STATE', 'Business pack request cannot be recovered: ' + reason);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPackDomain(value: string): value is BusinessPackDomain {
  return (BUSINESS_PACK_DOMAINS as readonly string[]).includes(value);
}

function markers(constraints: readonly string[], prefix: string): string[] {
  return constraints.filter(value => value.startsWith(prefix)).map(value => value.slice(prefix.length));
}

/**
 * Returns null for a generic mission. For a business-pack mission, returns the fingerprint-verified
 * request or throws: a pack mission whose request cannot be proven is never run as a generic one.
 */
export function recoverBusinessPackMission(goal: Goal | undefined): BusinessPackMission | null {
  const constraints = goal?.constraints ?? [];
  const packMarkers = markers(constraints, 'pack:');
  const contractMarkers = markers(constraints, 'contract:');
  const fingerprintMarkers = markers(constraints, 'fingerprint:');
  const record = goal?.serviceRequest;
  if (!packMarkers.length && !contractMarkers.length && !record) return null;
  if (!goal || !record) unrecoverable('no validated request was recorded for this operation');
  if (packMarkers.length !== 1 || contractMarkers.length !== 1 || fingerprintMarkers.length !== 1) {
    unrecoverable('pack identity constraints are missing or ambiguous');
  }
  const pack = packMarkers[0]!;
  if (!isPackDomain(pack)) unrecoverable('unknown pack');
  const contractKey = PACK_CONTRACT_KEYS[pack];
  if (contractMarkers[0] !== contractKey || record.contractKey !== contractKey || record.pack !== pack) {
    unrecoverable('pack or contract identity does not match the operation');
  }
  if (fingerprintMarkers[0] !== record.fingerprint || packRequestFingerprint(record.normalizedRequestJson) !== record.fingerprint) {
    unrecoverable('the recorded request does not match the approved fingerprint');
  }
  let request: unknown;
  try {
    request = JSON.parse(record.normalizedRequestJson);
  } catch {
    unrecoverable('the recorded request is not readable');
  }
  if (!isRecord(request) || request.pack !== pack) unrecoverable('the recorded request belongs to another pack');
  return {
    pack,
    contractKey,
    capabilityId: record.capabilityId,
    fingerprint: record.fingerprint,
    goalStatement: goal.statement,
    request,
  };
}

/**
 * The deliverable is produced by the plan's single terminal step, which must (transitively) depend on
 * every other step so it runs last, over all captured evidence. Every step must belong to the pack's
 * capability, which is what selects the pack's slot profile.
 */
export function businessPackStepRole(
  mission: BusinessPackMission,
  planSteps: readonly WorkStep[],
  step: WorkStep,
): BusinessPackStepRole {
  if (planSteps.some(candidate => candidate.capabilityId !== mission.capabilityId)) {
    throw new DomainError('DENIED', 'Business pack plan contains a step outside the pack capability');
  }
  const dependedOn = new Set(planSteps.flatMap(candidate => candidate.dependsOn));
  const terminal = planSteps.filter(candidate => !dependedOn.has(candidate.id));
  if (terminal.length !== 1) {
    throw new DomainError('INVALID_STATE', 'Business pack plan must have exactly one terminal deliverable step');
  }
  const sink = terminal[0]!;
  const byId = new Map(planSteps.map(candidate => [candidate.id, candidate] as const));
  const reached = new Set<string>();
  const pending = [...sink.dependsOn];
  while (pending.length) {
    const id = pending.pop()!;
    if (reached.has(id)) continue;
    reached.add(id);
    pending.push(...(byId.get(id as ID)?.dependsOn ?? []));
  }
  if (reached.size !== planSteps.length - 1) {
    throw new DomainError('INVALID_STATE', 'Business pack deliverable step does not depend on every other step');
  }
  return step.id === sink.id ? 'DELIVERABLE' : 'SUPPORTING';
}

/** The pack's request reaches the agent only through a context key its reviewed profile permits. */
export function assertBusinessPackProfile(profile: { readonly permittedContextKeys: readonly string[] }): void {
  if (!profile.permittedContextKeys.includes(REQUEST_CONTEXT_KEY)) {
    throw new DomainError('NOT_CONFIGURED', `Business pack agent profile must permit the '${REQUEST_CONTEXT_KEY}' context key`);
  }
}

/** ToolBroker captures of this revision with a citable URI and an exact response digest. */
export async function capturedPackSources(
  store: QeyNoxStore,
  workspaceId: ID,
  operationId: ID,
  revisionId: ID,
): Promise<readonly CapturedPackSource[]> {
  const attemptIds = (await store.db.select({ id: attempts.id }).from(attempts)
    .where(and(eq(attempts.operationId, operationId), eq(attempts.revisionId, revisionId)))).map(row => row.id);
  if (!attemptIds.length) return [];
  const evidenceRows = (await store.db.select().from(evidences)
    .where(and(eq(evidences.operationId, operationId), inArray(evidences.attemptId, attemptIds))))
    // A disputed or stale observation can neither support a claim nor be cited.
    .filter(row => row.payload.sourceId && row.payload.status !== 'DISPUTED' && row.payload.status !== 'STALE');
  const sourceIds = [...new Set(evidenceRows.map(row => row.payload.sourceId!))];
  if (!sourceIds.length) return [];
  const sourceRows = await store.db.select().from(sources)
    .where(and(eq(sources.workspaceId, workspaceId), eq(sources.operationId, operationId), inArray(sources.id, sourceIds)));
  const sourceById = new Map(sourceRows.map(row => [row.id, row.payload as Source] as const));
  return evidenceRows.flatMap(row => {
    const source = sourceById.get(row.payload.sourceId!);
    if (!source?.uri || !source.fingerprint) return [];
    return [{ sourceId: source.id, evidenceId: row.id as ID, uri: source.uri, responseDigest: source.fingerprint, provider: source.provider }];
  });
}

/**
 * Business instructions for one pack step. The customer request travels in `step:input` (filtered by
 * the profile like any private context); the output contract is part of the task itself, so the final
 * step always receives it.
 */
export function businessPackStepInstructions(
  mission: BusinessPackMission,
  step: WorkStep,
  role: BusinessPackStepRole,
  captured: readonly CapturedPackSource[],
  priorOutputs: unknown,
): { readonly userMessage: string; readonly context: Readonly<Record<string, unknown>> } {
  const schemaName = `${mission.pack}@1`;
  const citable = [...new Set(captured.map(source => source.uri))].slice(0, MAX_CITABLE_URIS);
  const context: Record<string, unknown> = {
    'goal:statement': mission.goalStatement,
    [REQUEST_CONTEXT_KEY]: {
      pack: mission.pack,
      contractKey: mission.contractKey,
      requestFingerprint: mission.fingerprint,
      stepIntent: step.intent,
      stepRole: role,
      request: mission.request,
    },
    'prior:summaries': priorOutputs,
  };
  if (role === 'SUPPORTING') {
    return {
      userMessage: step.description
        + `\n\nThis is a supporting step of the ${mission.contractKey} service. Work only on the request in ${REQUEST_CONTEXT_KEY}; the final step will emit the ${schemaName} deliverable.`,
      context,
    };
  }
  const outputContract = {
    format: `Return exactly one JSON object conforming to ${schemaName} and nothing else (an optional \`\`\`json fence is allowed; no other prose).`,
    pack: mission.pack,
    schemaVersion: 1,
    requiredSections: DELIVERABLE_SECTIONS_BY_PACK[mission.pack],
    citeOnlyCapturedSourceUris: citable,
    rules: [
      'Every cited URI must appear verbatim in citeOnlyCapturedSourceUris; any other URI rejects the whole deliverable.',
      'Never state guaranteed outcomes (ROI, revenue, rankings, conversions).',
      'Keep provider-observed facts, caller assumptions and your own interpretation in their designated fields.',
      'Do not invent sources, figures, people or contact details. Omit what the evidence does not support.',
      'Brave Search sources are discovery snippets, not fetched or verified page content. A response digest binds the search response, not an independent copy of each cited page. Disclose this evidence limitation.',
    ],
  };
  return {
    userMessage: step.description
      + `\n\nFINAL DELIVERABLE for ${mission.contractKey}. Output contract: ` + JSON.stringify(outputContract),
    context,
  };
}

function rebuild<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown, field: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) unrecoverable(`recorded request field '${field}' is invalid`);
  return parsed.data;
}

/** Validation context rebuilt from the recovered request, never from the agent output. */
export function packValidationContext(
  mission: BusinessPackMission,
  captured: readonly CapturedPackSource[],
): DeliverableValidationContext {
  const capturedSourceUris = [...new Set(captured.map(source => source.uri))];
  const request = mission.request;
  switch (mission.pack) {
    case 'strategy':
      return { capturedSourceUris, expectedCompetitors: rebuild(strategyPackRequestSchema.shape.competitors, request.competitors, 'competitors') };
    case 'marketing':
      return {
        capturedSourceUris,
        expectedChannels: rebuild(marketingPackRequestSchema.shape.candidateChannels, request.candidateChannels, 'candidateChannels'),
        monthlyMediaBudgetMinor: rebuild(marketingPackRequestSchema.shape.monthlyMediaBudgetMinor, request.monthlyMediaBudgetMinor, 'monthlyMediaBudgetMinor'),
      };
    case 'operations':
      return {
        capturedSourceUris,
        expectedDiagnostics: computeProcessDiagnostics(
          rebuild(operationsPackRequestSchema.shape.workflowStages, request.workflowStages, 'workflowStages'),
          rebuild(operationsPackRequestSchema.shape.targetSlaHours, request.targetSlaHours, 'targetSlaHours'),
        ),
      };
    case 'financial-analysis':
      return {
        capturedSourceUris,
        expectedSensitivity: computeFinancialSensitivity(
          rebuild(financialAnalysisPackRequestSchema.shape.baselineMetrics, request.baselineMetrics, 'baselineMetrics'),
          rebuild(financialAnalysisPackRequestSchema.shape.scenarios, request.scenarios, 'scenarios'),
        ),
      };
    default:
      return { capturedSourceUris };
  }
}

/**
 * Parses the actual Hermes output and validates it with the existing A16 validator. A rejected
 * deliverable throws INVALID_AGENT_OUTPUT; the caller records nothing.
 */
export function acceptBusinessPackDeliverable(
  mission: BusinessPackMission,
  rawOutput: string,
  captured: readonly CapturedPackSource[],
): { readonly deliverable: PackDeliverable; readonly projection: DeliverableResultProjection; readonly record: BusinessDeliverableRecord } {
  const context = packValidationContext(mission, captured);
  let deliverable: PackDeliverable;
  try {
    deliverable = extractStructuredDeliverableFromJson(mission.pack, rawOutput, context);
  } catch (error: unknown) {
    if (error instanceof DomainError && error.code === 'INVALID_INPUT') {
      throw new DomainError('INVALID_AGENT_OUTPUT', 'Business deliverable rejected: ' + error.message);
    }
    throw error;
  }
  return {
    deliverable,
    projection: projectDeliverableToResultSummary(deliverable),
    record: { pack: mission.pack, contractKey: mission.contractKey, requestFingerprint: mission.fingerprint, schemaVersion: 1, deliverable },
  };
}

/** sha256 of the raw agent output, recorded on the step evidence for traceability. */
export function rawOutputDigest(rawOutput: string): string {
  return createHash('sha256').update(rawOutput).digest('hex');
}

/**
 * Persists the projection's observed statements as domain claims. A claim citing a captured URI is
 * linked to every capture of that URI (exact response digest) and assessed against the capability's
 * active policy; a claim citing nothing stays UNVERIFIED. Interpretation, limitations and next actions
 * are not claims: they are carried by the recorded deliverable into the ResultDocument.
 */
export async function recordBusinessPackClaims(
  claimsService: ClaimsService,
  owner: Principal,
  scope: { readonly operationId: ID; readonly attemptId: ID; readonly profileId?: ID; readonly profileVersion?: number },
  mission: BusinessPackMission,
  projection: DeliverableResultProjection,
  captured: readonly CapturedPackSource[],
): Promise<number> {
  let recorded = 0;
  for (const observed of projection.observedClaimStatements) {
    const claim = await claimsService.register(owner, {
      operationId: scope.operationId,
      attemptId: scope.attemptId,
      statement: observed.statement,
      kind: CLAIM_KIND_PREFIX + mission.pack + ':observation',
      ...(scope.profileId ? { profileId: scope.profileId } : {}),
      ...(scope.profileVersion !== undefined ? { profileVersion: scope.profileVersion } : {}),
    });
    recorded++;
    const supporting = observed.sourceUri ? captured.filter(source => source.uri === observed.sourceUri) : [];
    const linked = new Set<string>();
    for (const source of supporting) {
      if (linked.has(source.evidenceId)) continue;
      linked.add(source.evidenceId);
      await claimsService.attach(owner, claim.id as ID, source.sourceId, 'SUPPORTS', source.evidenceId, source.responseDigest);
    }
    if (linked.size) {
      try {
        await claimsService.assessActive(owner, claim.id as ID);
      } catch (error: unknown) {
        // No active policy leaves the claim UNVERIFIED; any other failure is an integrity error.
        if (!(error instanceof DomainError) || error.code !== 'NOT_CONFIGURED') throw error;
      }
    }
  }
  return recorded;
}

function readDeliverableRecord(content: unknown): Record<string, unknown> | null {
  if (!isRecord(content) || !isRecord(content.businessDeliverable)) return null;
  return content.businessDeliverable;
}

/**
 * The validated deliverable of a business-pack revision, for ResultDocument assembly. Returns null
 * for a generic mission. For a pack mission it re-validates the recorded deliverable (schema and
 * prohibited claims) and re-projects it; a missing or mismatched deliverable throws, so a pack result
 * can never be assembled from anything else.
 */
export async function readBusinessPackResult(
  store: QeyNoxStore,
  actor: Principal,
  operationId: ID,
  revisionId: ID,
): Promise<{ readonly identity: ResultBusinessPack; readonly projection: DeliverableResultProjection } | null> {
  const mission = recoverBusinessPackMission(await store.getGoal(actor, operationId));
  if (!mission) return null;
  const rows = await store.db.select().from(stepOutputs)
    .where(and(eq(stepOutputs.operationId, operationId), eq(stepOutputs.revisionId, revisionId)))
    .orderBy(asc(stepOutputs.createdAt));
  const latest = rows.map(row => ({ row, record: readDeliverableRecord(row.content) })).filter(entry => entry.record).at(-1);
  if (!latest?.record) throw new DomainError('INVALID_STATE', 'Business pack deliverable is unavailable for this revision');
  const record = latest.record;
  if (record.pack !== mission.pack || record.contractKey !== mission.contractKey || record.requestFingerprint !== mission.fingerprint) {
    throw new DomainError('INVALID_STATE', 'Recorded business deliverable does not match the operation request');
  }
  const deliverable = validatePackDeliverable(mission.pack, record.deliverable);
  return {
    identity: { pack: mission.pack, contractKey: mission.contractKey, requestFingerprint: mission.fingerprint, attemptId: latest.row.attemptId as ID },
    projection: projectDeliverableToResultSummary(deliverable),
  };
}

import { DomainError, type ID, type Principal } from '@qeynox/domain';
import type { QeyNoxStore } from '@qeynox/persistence';
import { capabilityAvailability } from './capability-availability';
import type { PlanStepDraft, PlanningService } from './planning';
import type { RuntimeReadinessSource } from './runtime-readiness';
import { failClosedRuntime } from './runtime-readiness';

/**
 * MISSION A03 — the first operational business service: World Bank economic indicator research.
 *
 * The service accepts an EXPLICIT objective, country, indicator and constraints, validates them
 * against the reviewed provider contract, and produces a bounded plan. It never invents an
 * indicator code, a country, a provider permission or an economic conclusion:
 *
 * - country and indicator are validated against the reviewed World Bank shape (iso2/iso3 country,
 *   dotted indicator code) and against an explicit operator allowlist when one is configured;
 * - the plan is derived deterministically from the request (one research step, plus one analysis
 *   step when interpretation is requested), bounded by the capability's own maximumSteps;
 * - the returned draft carries the request fingerprint so a user approves a specific scope, not an
 *   opaque plan.
 *
 * Nothing here executes a provider call. Execution stays inside the worker through ToolBroker.
 */

/** Constraints a caller may impose. Everything is bounded and explicit; nothing is inferred. */
export interface ResearchConstraints {
  /** How many of the most recent observations to request (World Bank `mrnev`). */
  readonly mostRecent?: number;
  /** Accept only observations published at or after this year (client-side filter). */
  readonly minObservationYear?: number;
  /** Ordered indicator codes compared against `indicator`; all must be allowed. */
  readonly compareIndicators?: readonly string[];
  /** Ask for one interpretation step after the observations. */
  readonly includeInterpretation?: boolean;
  /** Free-form note carried into the plan and the result document. */
  readonly note?: string;
}

export interface ResearchRequest {
  /** The business objective in the customer's words. Required, never generated. */
  readonly objective: string;
  /** ISO 3166-1 alpha-2 or alpha-3 country code. */
  readonly country: string;
  /** World Bank indicator code, e.g. NY.GDP.MKTP.CD. */
  readonly indicator: string;
  readonly constraints?: ResearchConstraints;
}

export interface NormalizedResearchRequest {
  readonly objective: string;
  readonly country: string;
  readonly indicator: string;
  readonly mostRecent: number;
  readonly minObservationYear: number | null;
  readonly compareIndicators: readonly string[];
  readonly includeInterpretation: boolean;
  readonly note: string | null;
  /** Deterministic digest of the normalized request: what the user approves. */
  readonly fingerprint: string;
}

export interface ResearchServiceConfig {
  readonly capabilityId: ID;
  readonly offerId: string;
  /** Optional operator allowlist. Absent means "any shape-valid World Bank code". */
  readonly allowedCountries?: readonly string[];
  readonly allowedIndicators?: readonly string[];
  /** Hard ceiling on requested observations, independent of the caller. */
  readonly maximumObservations?: number;
}

export interface ResearchPlanProposal {
  readonly request: NormalizedResearchRequest;
  readonly capabilityId: ID;
  readonly offerId: string;
  readonly steps: readonly PlanStepDraft[];
  /** True when the operation must be quoted and accepted before execution. */
  readonly requiresUserApproval: boolean;
  /** Anything the caller should know before approving; empty when the scope is fully covered. */
  readonly warnings: readonly string[];
}

const COUNTRY_PATTERN = /^[A-Z]{2,3}$/;
const INDICATOR_PATTERN = /^[A-Z0-9]+(?:\.[A-Z0-9]+)+$/;
const MIN_OBJECTIVE = 20;
const MAX_OBJECTIVE = 5000;
const DEFAULT_OBSERVATIONS = 3;

/** Normalize and validate a research request. Pure: no database, no network. */
export function normalizeResearchRequest(input: ResearchRequest, config?: Pick<ResearchServiceConfig, 'allowedCountries' | 'allowedIndicators' | 'maximumObservations'>): NormalizedResearchRequest {
  const objective = typeof input.objective === 'string' ? input.objective.trim() : '';
  if (objective.length < MIN_OBJECTIVE) {
    throw new DomainError('INVALID_INPUT', 'A research objective of at least ' + MIN_OBJECTIVE + ' characters is required');
  }
  if (objective.length > MAX_OBJECTIVE) {
    throw new DomainError('INVALID_INPUT', 'The research objective exceeds ' + MAX_OBJECTIVE + ' characters');
  }
  const country = normalizeCode(input.country, 'country');
  if (!COUNTRY_PATTERN.test(country)) {
    throw new DomainError('INVALID_INPUT', 'Country must be an ISO 3166-1 alpha-2 or alpha-3 code');
  }
  const indicator = normalizeCode(input.indicator, 'indicator');
  if (!INDICATOR_PATTERN.test(indicator)) {
    throw new DomainError('INVALID_INPUT', 'Indicator must be a dotted World Bank indicator code, e.g. NY.GDP.MKTP.CD');
  }
  const constraints = input.constraints ?? {};
  const ceiling = Math.min(config?.maximumObservations ?? 5, 5);
  const mostRecent = constraints.mostRecent ?? Math.min(DEFAULT_OBSERVATIONS, ceiling);
  if (!Number.isInteger(mostRecent) || mostRecent < 1 || mostRecent > ceiling) {
    throw new DomainError('INVALID_INPUT', 'mostRecent must be an integer between 1 and ' + ceiling);
  }
  const minObservationYear = constraints.minObservationYear ?? null;
  if (minObservationYear !== null) {
    const currentYear = new Date().getUTCFullYear();
    if (!Number.isInteger(minObservationYear) || minObservationYear < 1960 || minObservationYear > currentYear) {
      throw new DomainError('INVALID_INPUT', 'minObservationYear must be between 1960 and ' + currentYear);
    }
  }
  const compareIndicators = [...new Set((constraints.compareIndicators ?? []).map(value => normalizeCode(value, 'comparison indicator')))];
  for (const code of compareIndicators) {
    if (!INDICATOR_PATTERN.test(code)) throw new DomainError('INVALID_INPUT', 'Comparison indicator must be a dotted World Bank indicator code: ' + code);
    if (code === indicator) throw new DomainError('INVALID_INPUT', 'A comparison indicator cannot repeat the primary indicator');
  }
  if (compareIndicators.length > 2) throw new DomainError('INVALID_INPUT', 'At most two comparison indicators are supported');
  const note = constraints.note?.trim() ?? null;
  if (note !== null && note.length > 500) throw new DomainError('INVALID_INPUT', 'The note exceeds 500 characters');

  // The caller cannot widen the operator allowlist; it can only choose inside it.
  if (config?.allowedCountries?.length) {
    const allowed = new Set(config.allowedCountries.map(value => value.toUpperCase()));
    if (!allowed.has(country)) throw new DomainError('DENIED', 'Country is outside the configured service scope: ' + country);
  }
  if (config?.allowedIndicators?.length) {
    const allowed = new Set(config.allowedIndicators.map(value => value.toUpperCase()));
    if (!allowed.has(indicator)) throw new DomainError('DENIED', 'Indicator is outside the configured service scope: ' + indicator);
    for (const code of compareIndicators) {
      if (!allowed.has(code)) throw new DomainError('DENIED', 'Comparison indicator is outside the configured service scope: ' + code);
    }
  }

  const normalized: NormalizedResearchRequest = {
    objective, country, indicator, mostRecent, minObservationYear,
    compareIndicators, includeInterpretation: constraints.includeInterpretation === true, note,
    fingerprint: '',
  };
  return { ...normalized, fingerprint: fingerprintOf(normalized) };
}

function normalizeCode(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new DomainError('INVALID_INPUT', 'A ' + label + ' is required');
  return value.trim().toUpperCase();
}

/** Deterministic request digest. The order of every field is fixed; no timestamps participate. */
function fingerprintOf(request: Omit<NormalizedResearchRequest, 'fingerprint'>): string {
  const canonical = JSON.stringify([
    request.objective, request.country, request.indicator, request.mostRecent,
    request.minObservationYear, request.compareIndicators, request.includeInterpretation, request.note,
  ]);
  let hash = 0x811c9dc5;
  for (let index = 0; index < canonical.length; index++) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0') + '-' + canonical.length.toString(16);
}

/**
 * Build the bounded execution plan for a normalized request. Pure.
 *
 * The plan is deliberately small and deterministic:
 *   1. RESEARCH — read the provider series for the requested country/indicator;
 *   2. optional ANALYZE — interpret only what step 1 captured, never a free-web request.
 * A capability with `maximumSteps < 2` cannot request interpretation; that is refused rather than
 * silently truncated.
 */
export function buildResearchPlan(request: NormalizedResearchRequest, options: {
  readonly capabilityId: ID;
  readonly offerId: string;
  readonly maximumSteps: number;
  readonly maximumToolCalls: number;
}): ResearchPlanProposal {
  const warnings: string[] = [];
  const toolCallsNeeded = 1 + request.compareIndicators.length;
  if (toolCallsNeeded > options.maximumToolCalls) {
    throw new DomainError('INVALID_INPUT', 'The request needs ' + toolCallsNeeded + ' provider reads but the capability allows ' + options.maximumToolCalls);
  }
  if (request.includeInterpretation && options.maximumSteps < 2) {
    throw new DomainError('INVALID_INPUT', 'Interpretation requires a capability with at least two plan steps');
  }
  if (request.minObservationYear !== null) {
    warnings.push('Observations published before ' + request.minObservationYear + ' are excluded by the caller constraint');
  }
  if (request.compareIndicators.length) {
    warnings.push('Comparison series are read separately and reported alongside the primary series');
  }

  const researchTitle = 'Read World Bank ' + request.indicator + ' for ' + request.country;
  const researchDescription = [
    'Read ' + request.mostRecent + ' most recent observations of ' + request.indicator + ' for ' + request.country,
    'from the reviewed World Bank Indicators provider through QeyNox ToolBroker.',
    request.note ? 'Caller note: ' + request.note : '',
  ].filter(Boolean).join(' ');

  const steps: PlanStepDraft[] = [{
    title: researchTitle,
    description: researchDescription,
    capabilityId: options.capabilityId,
    dependsOnIndices: [],
    intent: 'RESEARCH',
  }];
  if (request.includeInterpretation) {
    steps.push({
      title: 'Interpret the captured ' + request.indicator + ' series',
      description: 'Interpret only the observations captured in step 1 for ' + request.country + '. '
        + 'Separate observed values from interpretation, cite the captured response digest, and state freshness limits.',
      capabilityId: options.capabilityId,
      dependsOnIndices: [0],
      intent: 'ANALYZE',
    });
  }
  return {
    request,
    capabilityId: options.capabilityId,
    offerId: options.offerId,
    steps,
    // A priced offer always requires an explicit quote acceptance; a free offer still requires the
    // operation to be started deliberately, so approval is expressed by the commercial order.
    requiresUserApproval: true,
    warnings,
  };
}

/**
 * Service wrapper: validates configuration readiness, then proposes a plan.
 *
 * It reads the capability, its availability (provider/profile/policy/runtime) and refuses to
 * propose a plan the deployment could not execute. It creates nothing.
 */
export class EconomicResearchService {
  constructor(
    private readonly store: QeyNoxStore,
    private readonly config: ResearchServiceConfig,
    private readonly runtime: RuntimeReadinessSource = failClosedRuntime,
  ) {}

  async capability(): Promise<{ id: ID; maximumSteps: number; maximumToolCalls: number; slot: number; status: string }> {
    const definition = await this.store.getCapability(this.config.capabilityId);
    if (!definition) throw new DomainError('NOT_CONFIGURED', 'Research capability is not configured: ' + this.config.capabilityId);
    if (definition.status !== 'ACTIVE') throw new DomainError('NOT_CONFIGURED', 'Research capability is not ACTIVE: ' + this.config.capabilityId);
    return {
      id: definition.id, slot: definition.slot, status: definition.status,
      maximumSteps: definition.maximumSteps, maximumToolCalls: definition.maximumToolCalls,
    };
  }

  /** Availability of the service, using the same prerequisites the catalogue reports. */
  async availability(): Promise<{ readonly operationalState: string; readonly executable: boolean; readonly blockers: readonly string[] }> {
    const definition = await this.store.getCapability(this.config.capabilityId);
    if (!definition) return { operationalState: 'BLOCKED', executable: false, blockers: ['CAPABILITY_NOT_CONFIGURED'] };
    const index = await capabilityAvailability(this.store, [definition], this.runtime);
    const entry = index.byCapabilityId.get(definition.id);
    const blockers: string[] = [];
    if (!entry?.providerReady) blockers.push('PROVIDER_NOT_CONFIGURED');
    if (!entry?.profileReady) blockers.push('PROFILE_NOT_CONFIGURED');
    if (!entry?.policyReady) blockers.push('POLICY_NOT_CONFIGURED');
    if (this.runtime().overallState !== 'OPERATIONAL') blockers.push('RUNTIME_NOT_OPERATIONAL');
    return { operationalState: entry?.operationalState ?? 'BLOCKED', executable: entry?.isExecutable === true, blockers };
  }

  /**
   * Validate a request and return the plan proposal WITHOUT persisting it. The caller (API or
   * operator) then creates the operation and the plan revision, so a preview is side-effect free.
   */
  async propose(input: ResearchRequest): Promise<ResearchPlanProposal> {
    const capability = await this.capability();
    const request = normalizeResearchRequest(input, this.config);
    return buildResearchPlan(request, {
      capabilityId: this.config.capabilityId,
      offerId: this.config.offerId,
      maximumSteps: capability.maximumSteps,
      maximumToolCalls: capability.maximumToolCalls,
    });
  }

  /**
   * Create the operation and its bounded plan for an authenticated principal.
   *
   * The plan revision is what the user approves. `PlanningService` performs its own capability and
   * dependency validation; this method adds the request-level guarantees above.
   */
  async createPlan(
    actor: Principal,
    input: ResearchRequest,
    planning: PlanningService,
  ): Promise<{ operationId: ID; revisionId: ID; request: NormalizedResearchRequest; steps: readonly PlanStepDraft[]; warnings: readonly string[] }> {
    const proposal = await this.propose(input);
    const operation = await this.store.createOperation(actor, titleOf(proposal.request), proposal.request.objective, []);
    const plan = await planning.create(actor, operation.id, operation.version, proposal.steps);
    return {
      operationId: operation.id,
      revisionId: plan.revision.id,
      request: proposal.request,
      steps: proposal.steps,
      warnings: proposal.warnings,
    };
  }
}

function titleOf(request: NormalizedResearchRequest): string {
  return request.indicator + ' · ' + request.country;
}

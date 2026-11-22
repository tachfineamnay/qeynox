import { createHash } from 'node:crypto';
import { DomainError, validateDraftDependencies, type ID, type Principal } from '@qeynox/domain';
import { planProposalOutputSchema, type PlanProposalOutput } from '@qeynox/contracts';
import type { AgentProfile, EngineOutcome, EnginePort } from '@qeynox/engine';
import type { CapabilityRegistry } from './capabilities';

/**
 * MISSION A12 — Pilot plan proposal.
 *
 * A customer states a business objective; this module asks the replaceable engine (through the same
 * Hermes `EnginePort` Soul uses) for a STRUCTURED draft plan: steps, capability references,
 * dependencies and expected deliverables. The result is advisory in the strongest sense of the word:
 *
 * 1. **Nothing is persisted.** No plan, plan revision, step, event or budget row is written by this
 *    module. The customer persists a plan explicitly, through the existing plan endpoints, after
 *    editing the draft in Flow. Approval stays the customer's act, never this module's.
 * 2. **Bounded.** Fixed step ceiling (40), fixed output ceiling, an outer per-attempt timeout, and
 *    one model call per client-supplied attempt key so a retry is free.
 * 3. **Distinguishable.** Every result states whether the steps came from the model or the
 *    deterministic fallback, and why. Steps the model did not produce are never labelled AI, and
 *    engine text is never "repaired" into validity — anything unparseable or unverifiable is
 *    refused whole.
 * 4. **Every fact is verified against recorded configuration.** Capability ids must reference an
 *    ACTIVE slot; per-capability step ceilings are enforced; EXTERNAL_ACTION steps require a
 *    capability with reviewed tools; dependency indices must stay in range and acyclic. A proposal
 *    that fails any check is refused whole — never partially accepted.
 * 5. **Honest about readiness.** The proposal reports the deployment's real operational state per
 *    referenced capability (from the caller-supplied readiness snapshot) and the workspace budget
 *    boundary. It never claims a capability can run when the deployment cannot prove it.
 */

export const MAX_PROPOSAL_STEPS = 40;
const MAX_OUTPUT_BYTES = 24_000;
const CACHE_LIMIT = 200;

export type PlanProposalReason =
  | 'OK'
  | 'NO_CAPABILITIES'
  | 'ENGINE_NOT_CONFIGURED'
  | 'ENGINE_UNAVAILABLE'
  | 'ENGINE_TIMEOUT'
  | 'ENGINE_REFUSED'
  | 'ENGINE_EMPTY'
  | 'INVALID_PROPOSAL';

export interface PlanProposalRequestInput {
  /** What the customer typed, already constrained by the API contract. */
  readonly attemptKey: string;
  readonly locale: 'en' | 'fr';
  /** Answers to readiness questions from an earlier proposal pass. */
  readonly answers?: readonly { readonly question: string; readonly answer: string }[];
}

export interface ProposalReadiness {
  readonly operationalState?: string;
  readonly isExecutable?: boolean;
  readonly missingProviders?: readonly string[];
  readonly missingPolicies?: readonly string[];
}

export interface ProposalStepView {
  readonly index: number;
  readonly title: string;
  readonly description: string;
  readonly capabilityId: string;
  readonly intent: 'RESEARCH' | 'ANALYZE' | 'VERIFY' | 'EXTERNAL_ACTION';
  readonly dependsOnIndices: readonly number[];
  readonly expectedDeliverable: string;
}

export interface ProposalCapabilityNote {
  readonly capabilityId: string;
  readonly name: string;
  readonly operationalState: string;
  readonly isExecutable: boolean;
  readonly missingProviders: readonly string[];
  readonly missingPolicies: readonly string[];
}

/** The workspace budget boundary an execution would be held to. Never money the customer invented. */
export interface ProposalBudgetBoundary {
  readonly configured: boolean;
  readonly currency?: string;
  readonly maxMoneyMinor?: number;
  readonly maxAgentCalls?: number;
  readonly maxToolCalls?: number;
  readonly maxDurationSeconds?: number;
}

export interface PlanProposalResult {
  readonly source: 'AI' | 'DETERMINISTIC_FALLBACK';
  readonly aiGenerated: boolean;
  readonly reason: PlanProposalReason;
  readonly engineAttempted: boolean;
  readonly summary: string | null;
  readonly deliverables: readonly string[];
  readonly assumptions: readonly string[];
  readonly questions: readonly string[];
  readonly steps: readonly ProposalStepView[];
  readonly capabilityNotes: readonly ProposalCapabilityNote[];
  readonly budget: ProposalBudgetBoundary;
  /** True when at least one step would require explicit customer approval before execution. */
  readonly requiresApproval: boolean;
  readonly generatedAt: string;
}

export interface PlanProposalOperation {
  readonly id: ID;
  readonly title: string;
  readonly status: string;
}

export interface PlanGoal {
  readonly statement: string;
  readonly constraints: readonly string[];
}

export interface PlanProposalOptions {
  readonly now?: () => Date;
  readonly timeoutMs?: number;
  /** Idempotency cache shared across requests (module scope recommended). */
  readonly attemptCache?: Map<string, PlanProposalResult>;
  /** Read-only workspace budget-policy peek. Absent/failing = boundary reported as unknown. */
  readonly peekBudget?: (actor: Principal) => Promise<ProposalBudgetBoundary>;
}

/** The workspace-scoped, ACTIVE capability catalogue rendered for the prompt. Pure. */
export function buildCapabilityCatalogue(registry: CapabilityRegistry): {
  id: string; name: string; purpose: string; scope: readonly string[];
  maximumSteps: number; maximumToolCalls: number; hasReviewedTools: boolean;
}[] {
  return registry.list()
    .filter(entry => entry.status === 'ACTIVE' && entry.definition)
    .map(entry => {
      const definition = entry.definition!;
      return {
        id: definition.id,
        name: definition.name ?? '',
        purpose: definition.purpose ?? '',
        scope: definition.scope,
        maximumSteps: definition.maximumSteps,
        maximumToolCalls: definition.maximumToolCalls,
        hasReviewedTools: definition.allowedTools.length > 0,
      };
    });
}

export interface PlanPromptInput {
  readonly locale: 'en' | 'fr';
  readonly operationTitle: string;
  readonly goal: PlanGoal | null;
  readonly answers: readonly { readonly question: string; readonly answer: string }[];
  readonly catalogue: ReturnType<typeof buildCapabilityCatalogue>;
}

/**
 * Pure prompt construction. Narrow by design: the objective, the constraints, the answers already
 * given, and exactly the ACTIVE capability slots with their real ceilings — nothing from other
 * workspaces, no consented facts, no operation history beyond this mission.
 */
export function buildPlanPrompt(input: PlanPromptInput): string {
  const catalogue = input.catalogue.map(entry => [
    '- capabilityId: ' + entry.id,
    '  name: ' + entry.name,
    '  purpose: ' + entry.purpose,
    '  scope: ' + entry.scope.join('; '),
    '  maximumSteps: ' + String(entry.maximumSteps) + ' · maximumToolCalls: ' + String(entry.maximumToolCalls),
    '  reviewedTools: ' + (entry.hasReviewedTools ? 'yes' : 'no'),
  ].join('\n')).join('\n');
  const answers = input.answers.length
    ? input.answers.map(a => '- ' + a.question + ' → ' + a.answer).join('\n')
    : '- (none)';
  const constraints = input.goal?.constraints?.length ? input.goal.constraints.map(c => '- ' + c).join('\n') : '- (none recorded)';
  return [
    'You are QeyNox Pilot, proposing a draft execution plan for a business objective.',
    'Customer language: ' + (input.locale === 'fr' ? 'French' : 'English') + '. Write every string value in that language.',
    'Mission: ' + input.operationTitle,
    'Objective: ' + (input.goal?.statement ?? input.operationTitle),
    'Constraints recorded by the customer:',
    constraints,
    'Answers already given to your earlier questions:',
    answers,
    '',
    'ACTIVE business capabilities you may reference (referenced by exact id, nothing else exists):',
    catalogue,
    '',
    'Rules you must follow:',
    '- Respond with ONLY a JSON object. No prose, no markdown fences, no commentary.',
    '- Schema: {"summary":string,"deliverables":string[],"assumptions":string[],"questions":string[],"steps":[{"title":string,"description":string,"capabilityId":string,"intent":"RESEARCH"|"ANALYZE"|"VERIFY"|"EXTERNAL_ACTION","dependsOnIndices":number[],"expectedDeliverable":string}]}',
    '- steps may contain at most ' + String(MAX_PROPOSAL_STEPS) + ' entries. Prefer fewer, substantive steps.',
    '- Each capabilityId MUST be one of the ACTIVE capability ids listed above. Never invent, rename or paraphrase one.',
    '- Never exceed a capability\'s maximumSteps across all steps that use it.',
    '- dependsOnIndices holds the zero-based positions of earlier or later steps in this same array. No self references, no cycles.',
    '- Use EXTERNAL_ACTION only when the chosen capability has reviewedTools: yes. Every EXTERNAL_ACTION step will require explicit customer approval.',
    '- If the objective is too under-specified to draft, return your best minimal draft AND put at most 3 short questions in "questions". Never ask more than 3.',
    '- Do not invent prices, costs, providers, sources, statistics, market data or success claims. Plans never quote money.',
    '- Do not promise business or financial success. State assumptions explicitly in "assumptions".',
    '- Each step must say what it hands over in expectedDeliverable (one line, concrete).',
    '- Do not claim to have used a tool, browsed the web or read any source.',
  ].join('\n');
}

/** Extract and parse the first balanced JSON object in the model output. Never repairs content. */
export function extractPlanJson(content: string): unknown | null {
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(content.slice(start, end + 1)) as unknown;
  } catch {
    return null;
  }
}

export function looksLikePlanRefusal(content: string): boolean {
  const head = content.slice(0, 120).toLowerCase().trim();
  return /^(i can(?:no|')t (?:help|assist|draft|create|do that)|i'm (?:sorry|unable)|i am unable|as an ai|je ne peux pas (?:vous )?(?:aider|créer)|d[ée]sol[ée],? je ne peux)/.test(head);
}

export interface ValidatedProposal {
  readonly output: PlanProposalOutput;
  readonly steps: readonly ProposalStepView[];
  readonly requiresApproval: boolean;
}

/**
 * Full semantic validation of a parsed proposal against recorded configuration.
 * Any violation rejects the WHOLE proposal — a partially valid draft is never shown as one.
 */
export function validatePlanProposal(
  output: PlanProposalOutput,
  registry: CapabilityRegistry,
): { readonly ok: true; readonly value: ValidatedProposal } | { readonly ok: false; readonly detail: string } {
  if (output.steps.length > MAX_PROPOSAL_STEPS) return { ok: false, detail: 'Too many steps' };

  const stepPerCapability = new Map<string, number>();
  const entries: { id: string; dependsOn: string[] }[] = [];
  for (let index = 0; index < output.steps.length; index++) {
    const step = output.steps[index]!;
    let definition;
    try {
      definition = registry.get(step.capabilityId as ID);
    } catch {
      return { ok: false, detail: 'Unknown or inactive capability: ' + step.capabilityId };
    }
    for (const dep of step.dependsOnIndices) {
      if (!Number.isInteger(dep) || dep < 0 || dep >= output.steps.length) {
        return { ok: false, detail: 'Dependency index outside the proposed plan' };
      }
      if (dep === index) return { ok: false, detail: 'Self dependency' };
    }
    if (step.intent === 'EXTERNAL_ACTION' && definition.allowedTools.length === 0) {
      return { ok: false, detail: 'External action requires a capability with reviewed tools: ' + step.capabilityId };
    }
    stepPerCapability.set(step.capabilityId, (stepPerCapability.get(step.capabilityId) ?? 0) + 1);
    entries.push({ id: 'draft-' + String(index), dependsOn: step.dependsOnIndices.map(dep => 'draft-' + String(dep)) });
  }
  for (const [capabilityId, count] of stepPerCapability) {
    const definition = registry.get(capabilityId as ID);
    if (count > definition.maximumSteps) {
      return { ok: false, detail: 'Capability step ceiling exceeded (' + String(definition.maximumSteps) + '): ' + capabilityId };
    }
  }
  try {
    validateDraftDependencies(entries);
  } catch {
    return { ok: false, detail: 'Cyclic or invalid plan dependencies' };
  }

  const requiresApproval = output.steps.some(step => step.intent === 'EXTERNAL_ACTION');
  return {
    ok: true,
    value: {
      output,
      steps: output.steps.map((step, index) => ({
        index,
        title: step.title,
        description: step.description,
        capabilityId: step.capabilityId,
        intent: step.intent,
        dependsOnIndices: step.dependsOnIndices,
        expectedDeliverable: step.expectedDeliverable,
      })),
      requiresApproval,
    },
  };
}

export interface PlanProposalPort {
  proposePlan(
    actor: Principal,
    operation: PlanProposalOperation,
    goal: PlanGoal | null,
    input: PlanProposalRequestInput,
    readiness?: ReadonlyMap<string, ProposalReadiness>,
  ): Promise<PlanProposalResult>;
}

/** Shared, bounded idempotency cache for proposal attempts. Module scope so it survives requests. */
export const proposalAttemptCache = new Map<string, PlanProposalResult>();

export type ProposalCapabilitiesPort = (actor: Principal) => Promise<CapabilityRegistry>;

export class PlanProposalService implements PlanProposalPort {
  private readonly now: () => Date;
  private readonly timeoutMs: number;
  private readonly cache: Map<string, PlanProposalResult>;

  constructor(
    private readonly engine: EnginePort,
    private readonly profileFor: (actor: Principal) => Promise<AgentProfile>,
    private readonly capabilities: CapabilityRegistry | ProposalCapabilitiesPort,
    options: PlanProposalOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.timeoutMs = options.timeoutMs ?? 25_000;
    this.cache = options.attemptCache ?? proposalAttemptCache;
    this.peekBudgetFn = options.peekBudget;
  }

  async proposePlan(
    actor: Principal,
    operation: PlanProposalOperation,
    goal: PlanGoal | null,
    input: PlanProposalRequestInput,
    readiness?: ReadonlyMap<string, ProposalReadiness>,
  ): Promise<PlanProposalResult> {
    if (!input.attemptKey || input.attemptKey.length < 8 || input.attemptKey.length > 120) {
      throw new DomainError('INVALID_INPUT', 'An attempt key of 8 to 120 characters is required for idempotent proposals');
    }
    const budget = await this.peekBudget(actor);
    // One fresh snapshot per proposal, never a database read during dependency injection.
    const capabilities = typeof this.capabilities === 'function' ? await this.capabilities(actor) : this.capabilities;
    const catalogue = buildCapabilityCatalogue(capabilities);
    if (catalogue.length === 0) {
      return this.fallback('NO_CAPABILITIES', false, budget);
    }

    const answers = (input.answers ?? []).slice(0, 10);
    let profile: AgentProfile;
    try {
      profile = await this.profileFor(actor);
    } catch (error: unknown) {
      return this.fallbackFromError(error, budget);
    }

    // Configuration and prompt changes invalidate a cached result; unchanged retries stay free.
    // Include readiness/budget so a cache hit cannot revive stale operational or monetary claims.
    const fingerprint = createHash('sha256').update(JSON.stringify({
      operation, goal, input, catalogue, capabilityConfiguration: capabilities.list(), budget, profile,
      readiness: readiness ? [...readiness.entries()].sort(([left], [right]) => left.localeCompare(right)) : [],
    })).digest('hex');
    const cacheKey = JSON.stringify([actor.workspaceId, actor.userId, operation.id, input.attemptKey, fingerprint]);
    const prior = this.cache.get(cacheKey);
    if (prior) return prior;

    let outcome: EngineOutcome;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // A hung engine is bounded even if it ignores the abort signal; the race rejects first.
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(Object.assign(new Error('plan proposal timed out'), { name: 'AbortError' }));
      }, this.timeoutMs);
    });
    try {
      outcome = await Promise.race([
        this.engine.invoke({
          workspaceId: actor.workspaceId,
          operationId: operation.id,
          stepAttemptId: ('pilot-proposal-' + createHash('sha256').update(cacheKey).digest('hex').slice(0, 24)) as ID,
          profile,
          userMessage: buildPlanPrompt({ locale: input.locale, operationTitle: operation.title, goal, answers, catalogue }),
          // No consented facts and no document content: a plan never needs the memory store.
          context: {},
          correlationId: createHash('sha256').update(cacheKey).digest('hex').slice(0, 32),
          priorMessages: [],
        }, { signal: controller.signal }),
        timeout,
      ]);
    } catch (error: unknown) {
      return this.fallbackFromError(error, budget);
    } finally {
      if (timer) clearTimeout(timer);
    }

    const result = this.interpret(outcome, input, catalogue, capabilities, budget, readiness);
    this.remember(cacheKey, result);
    return result;
  }

  private interpret(
    outcome: EngineOutcome,
    input: PlanProposalRequestInput,
    catalogue: ReturnType<typeof buildCapabilityCatalogue>,
    capabilities: CapabilityRegistry,
    budget: ProposalBudgetBoundary,
    readiness?: ReadonlyMap<string, ProposalReadiness>,
  ): PlanProposalResult {
    const content = (outcome.content ?? '').trim();
    if (outcome.status === 'FAILED') return this.fallback('ENGINE_UNAVAILABLE', true, budget);
    if (content.length === 0) return this.fallback('ENGINE_EMPTY', true, budget);
    if (outcome.status !== 'COMPLETED') return this.fallback('ENGINE_UNAVAILABLE', true, budget);
    if (looksLikePlanRefusal(content)) return this.fallback('ENGINE_REFUSED', true, budget);
    if (content.length > MAX_OUTPUT_BYTES) return this.fallback('INVALID_PROPOSAL', true, budget);

    const parsed = planProposalOutputSchema.safeParse(extractPlanJson(content));
    if (!parsed.success) return this.fallback('INVALID_PROPOSAL', true, budget);
    const validated = validatePlanProposal(parsed.data, capabilities);
    if (!validated.ok) return this.fallback('INVALID_PROPOSAL', true, budget);

    const usedIds = [...new Set(validated.value.steps.map(step => step.capabilityId))];
    const catalogueById = new Map(catalogue.map(entry => [entry.id, entry]));
    const capabilityNotes: ProposalCapabilityNote[] = usedIds.map(capabilityId => {
      const view = catalogueById.get(capabilityId)!;
      const ready = readiness?.get(capabilityId);
      return {
        capabilityId,
        name: view.name,
        operationalState: ready?.operationalState ?? 'UNVERIFIED',
        isExecutable: ready?.isExecutable ?? false,
        missingProviders: ready?.missingProviders ?? [],
        missingPolicies: ready?.missingPolicies ?? [],
      };
    });

    return {
      source: 'AI',
      aiGenerated: true,
      reason: 'OK',
      engineAttempted: true,
      summary: parsed.data.summary,
      deliverables: parsed.data.deliverables,
      assumptions: parsed.data.assumptions,
      questions: parsed.data.questions.slice(0, 3), // the model may return up to 6; the customer is asked at most 3
      steps: validated.value.steps,
      capabilityNotes,
      budget,
      requiresApproval: validated.value.requiresApproval,
      generatedAt: this.now().toISOString(),
    };
  }

  private readonly peekBudgetFn?: (actor: Principal) => Promise<ProposalBudgetBoundary>;

  /** Reads the workspace ACTIVE budget policy without creating anything. Unreadable = not configured. */
  private async peekBudget(actor: Principal): Promise<ProposalBudgetBoundary> {
    if (!this.peekBudgetFn) return { configured: false };
    try {
      return await this.peekBudgetFn(actor);
    } catch {
      // A budget row that fails validation is reported as unknown, never as an invented ceiling.
      return { configured: false };
    }
  }

  private remember(cacheKey: string, result: PlanProposalResult): void {
    if (this.cache.size >= CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(cacheKey, result);
  }

  private fallback(reason: PlanProposalReason, engineAttempted: boolean, budget: ProposalBudgetBoundary): PlanProposalResult {
    return {
      source: 'DETERMINISTIC_FALLBACK',
      aiGenerated: false,
      reason,
      engineAttempted,
      summary: null,
      deliverables: [],
      assumptions: [],
      questions: [],
      steps: [],
      capabilityNotes: [],
      budget,
      requiresApproval: false,
      generatedAt: this.now().toISOString(),
    };
  }

  private fallbackFromError(error: unknown, budget: ProposalBudgetBoundary): PlanProposalResult {
    const reason: PlanProposalReason = error instanceof DomainError && error.code === 'NOT_CONFIGURED'
      ? 'ENGINE_NOT_CONFIGURED'
      : (error as { name?: string } | null)?.name === 'AbortError'
        ? 'ENGINE_TIMEOUT'
        : 'ENGINE_UNAVAILABLE';
    return this.fallback(reason, true, budget);
  }
}

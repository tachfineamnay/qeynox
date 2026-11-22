import { createHash } from 'node:crypto';
import { DomainError, type ID, type Principal } from '@qeynox/domain';
import type { AgentProfile, EnginePort, EngineOutcome } from '@qeynox/engine';

/**
 * MISSION A05 — intelligent pre-mission Soul onboarding.
 *
 * The onboarding state machine (WELCOME → LANGUAGE → CONSENT → ACTIVITY → OBJECTIVES → NEEDS →
 * PREFERENCES → FIRST_OBJECTIVE → DONE) is unchanged and remains the only writer of progress,
 * consent and facts. This module adds an OPTIONAL advisory layer on top of it: a bounded
 * conversation that helps the customer articulate an objective and asks only the questions still
 * relevant to it.
 *
 * Five rules make the layer safe to have:
 *
 * 1. **Advisory only.** It never advances, skips or completes a step, and never writes a fact. The
 *    customer still submits answers through the deterministic endpoints.
 * 2. **Bounded.** Fixed turn ceiling, fixed output ceiling enforced by the profile, an outer
 *    per-attempt timeout, and one model call per client-supplied attempt key so a retry is free.
 * 3. **Distinguishable.** Every result states whether the text came from the model or the
 *    deterministic fallback, and why. Text the model did not produce is never labelled AI.
 * 4. **No invented facts, no second memory.** The model sees only what the customer typed into this
 *    onboarding (progressive, not the whole transcript) plus its own prior guidance, which is
 *    carried in the response and never persisted here.
 * 5. **Operation-free inference.** These calls happen BEFORE a mission exists, so the existing
 *    operation-bound `/v1/soul/converse` contract is untouched. `EngineRequest` requires an
 *    operation and attempt identity; this module derives a namespaced placeholder from the
 *    onboarding row so nothing can ever be mistaken for a real mission, and it neither reads nor
 *    writes any operation row.
 */

/** Steps the advisory layer may discuss: only the ones that ask the customer for meaning. */
const guidedSteps = ['ACTIVITY', 'OBJECTIVES', 'NEEDS', 'PREFERENCES', 'FIRST_OBJECTIVE'] as const;
export type GuidedStep = (typeof guidedSteps)[number];
export function isGuidedStep(step: string): step is GuidedStep {
  return (guidedSteps as readonly string[]).includes(step);
}

/** Maximum customer turns per onboarding conversation. Beyond this only the fallback answers. */
export const MAX_GUIDED_TURNS = 12;
export const MAX_GUIDANCE_MESSAGE = 2000;
const MAX_CONTEXT_TURNS = 8;

export type GuidanceSource = 'AI' | 'DETERMINISTIC_FALLBACK';

export type GuidanceReason =
  | 'OK'
  | 'ENGINE_NOT_CONFIGURED'
  | 'ENGINE_UNAVAILABLE'
  | 'ENGINE_TIMEOUT'
  | 'ENGINE_REFUSED'
  | 'ENGINE_EMPTY'
  | 'TURN_LIMIT';

export interface GuidedTurn {
  readonly role: 'CUSTOMER' | 'SOUL';
  readonly content: string;
  readonly at: string;
  /** Only SOUL turns carry a source; a customer turn is never attributed to the model. */
  readonly source?: GuidanceSource;
}

export interface GuidanceResult {
  readonly source: GuidanceSource;
  readonly reason: GuidanceReason;
  /** True only when the customer received model-generated text. */
  readonly aiGenerated: boolean;
  readonly content: string;
  readonly turn: GuidedTurn;
  readonly turns: { readonly used: number; readonly maximum: number };
  /** Deterministic question text; present whenever the fallback answered. */
  readonly fallbackQuestion?: string;
  /** False only when the fallback answered without contacting the engine at all. */
  readonly engineAttempted: boolean;
}

export interface GuidedRequest {
  readonly consentBindings?: readonly {id:string;version:number}[];
  /** Identity of the onboarding row; the placeholder ids are derived from it. */
  readonly onboardingId: string;
  readonly step: GuidedStep;
  /** What the customer typed. Absent means "I need help with this question". */
  readonly message?: string;
  /** Answers already given in this onboarding, so the model does not re-ask them. */
  readonly answers?: readonly { readonly step: string; readonly value: string | readonly string[] }[];
  /** Prior turns of THIS conversation. Client-held; never persisted by this module. */
  readonly history?: readonly GuidedTurn[];
  /** Idempotency key for one attempt. A replay returns the first result verbatim. */
  readonly attemptKey: string;
  /** Customer language from the onboarding record. Never inferred from the message. */
  readonly locale: 'en' | 'fr';
}

export interface GuidedOnboardingPort {
  guide(actor: Principal, request: GuidedRequest): Promise<GuidanceResult>;
}

export interface GuidancePromptInput {
  readonly locale: 'en' | 'fr';
  readonly step: GuidedStep;
  readonly message: string;
  readonly answers: readonly { readonly step: string; readonly value: string | readonly string[] }[];
  readonly history: readonly GuidedTurn[];
}

/**
 * Pure, testable prompt construction. Deliberately narrow: the step being asked, the answers already
 * given, the recent turns and the new message — and nothing from the consented fact store, other
 * workspaces or the operation history.
 */
export function buildGuidanceMessage(input: GuidancePromptInput): string {
  const answers = input.answers.length
    ? input.answers
      .map(answer => '- ' + answer.step + ': ' + (Array.isArray(answer.value) ? answer.value.join('; ') : String(answer.value)))
      .join('\n')
    : '- (none yet)';
  const recent = input.history.slice(-MAX_CONTEXT_TURNS)
    .map(turn => (turn.role === 'CUSTOMER' ? 'Customer: ' : 'Soul: ') + turn.content)
    .join('\n');
  return [
    'You are QeyNox Soul, guiding a new customer through pre-mission onboarding.',
    'Current onboarding question: ' + input.step + '.',
    'Customer language: ' + (input.locale === 'fr' ? 'French' : 'English') + '. Always answer in that language.',
    'Answers already given in this onboarding:',
    answers,
    recent ? 'Recent conversation:\n' + recent : '',
    'Customer now says: ' + (input.message || '(no message — they need help with this question)'),
    '',
    'Rules you must follow:',
    '- Ask at most ONE clarifying question. Ask none if the answers above already establish the objective.',
    '- Do not invent facts about the customer, their company, revenue, competitors or market.',
    '- Do not promise business or financial success, and give no financial advice.',
    '- Never claim to have used a tool, browsed the web or read any source.',
    '- Keep the reply under 120 words and end with a single concrete question when you ask one.',
  ].filter(Boolean).join('\n');
}

/** Deterministic, locale-aware guidance used whenever the model cannot answer. Pure. */
export function fallbackQuestion(locale: 'en' | 'fr', step: GuidedStep): string {
  const text: Record<GuidedStep, { en: string; fr: string }> = {
    ACTIVITY: {
      en: 'What does your business do, in one or two sentences?',
      fr: 'Que fait votre entreprise, en une ou deux phrases ?',
    },
    OBJECTIVES: {
      en: 'What outcome would make the next few weeks worthwhile for you?',
      fr: 'Quel résultat rendrait les prochaines semaines utiles pour vous ?',
    },
    NEEDS: {
      en: 'What is missing today that stops you from reaching it?',
      fr: "Qu'est-ce qui manque aujourd'hui pour y arriver ?",
    },
    PREFERENCES: {
      en: 'How do you prefer to work: short briefs, detailed analysis, or something else?',
      fr: 'Comment préférez-vous travailler : notes courtes, analyse détaillée, autre chose ?',
    },
    FIRST_OBJECTIVE: {
      en: 'Describe the first mission you want QeyNox to run, in one sentence.',
      fr: 'Décrivez la première mission que QeyNox doit mener, en une phrase.',
    },
  };
  return text[step][locale];
}

export interface GuidedOnboardingOptions {
  readonly authorize?: (actor:Principal,profile:AgentProfile,request:GuidedRequest)=>Promise<void>;
  readonly now?: () => Date;
  /** Outer bound the caller waits for. The engine has its own, shorter, transport timeout. */
  readonly timeoutMs?: number;
  /** Idempotency cache, scoped by the creating module. */
  readonly attemptCache?: Map<string, GuidanceResult>;
}

/**
 * Namespaced placeholder identity. `EngineRequest` requires an operation and an attempt id, but
 * pre-mission onboarding has no operation and must not fabricate one: these ids are prefixed so they
 * can never collide with a real operation id, are derived only from the onboarding row, and are
 * never written to `operations` or `operation_steps`.
 */
export function placeholderIdentity(onboardingId: string, step: GuidedStep): { operationId: ID; stepAttemptId: ID } {
  const digest = createHash('sha256').update('soul-onboarding:' + onboardingId + ':' + step).digest('hex');
  return {
    operationId: ('onboarding-op-' + digest.slice(0, 24)) as ID,
    stepAttemptId: ('onboarding-attempt-' + digest.slice(24, 48)) as ID,
  };
}

/**
 * Guided onboarding over the existing `EnginePort`.
 *
 * Refusal, a non-completed outcome, an offline engine, a timeout, a malformed or empty completion all
 * resolve to the deterministic fallback with a reason. None of them throws: onboarding must stay
 * usable when the model is not, and the customer is always told which one they got.
 */
export class GuidedOnboardingService implements GuidedOnboardingPort {
  private readonly now: () => Date;
  private readonly timeoutMs: number;
  private readonly cache: Map<string, GuidanceResult>;

  constructor(
    private readonly engine: EnginePort,
    private readonly profileFor: (actor: Principal) => Promise<AgentProfile>,
    private readonly options: GuidedOnboardingOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.cache = options.attemptCache ?? new Map();
  }

  async guide(actor: Principal, request: GuidedRequest): Promise<GuidanceResult> {
    if (!isGuidedStep(request.step)) {
      throw new DomainError('INVALID_INPUT', 'This onboarding step does not accept guided input');
    }
    if (!request.attemptKey || request.attemptKey.length < 8 || request.attemptKey.length > 120) {
      throw new DomainError('INVALID_INPUT', 'An attempt key of 8 to 120 characters is required for idempotent guidance');
    }
    if (!request.onboardingId) {
      throw new DomainError('INVALID_INPUT', 'An onboarding record is required for guided input');
    }

    // Scoped by workspace AND user: one workspace's attempt key can never replay another's result.
    const cacheKey = actor.workspaceId + ':' + actor.userId + ':' + request.attemptKey;
    const prior = this.cache.get(cacheKey);
    if (prior) return prior;

    const message = (request.message ?? '').trim();
    if (message.length > MAX_GUIDANCE_MESSAGE) throw new DomainError('INVALID_INPUT', 'Message is too long');
    const history = request.history ?? [];
    const turnsUsed = history.filter(turn => turn.role === 'CUSTOMER').length + (message ? 1 : 0);

    if (turnsUsed > MAX_GUIDED_TURNS) {
      // The conversation budget is spent. Answer deterministically; do not call the model.
      return this.fallback(request, turnsUsed, 'TURN_LIMIT', false);
    }

    // Profile resolution is part of the same degradation contract: an operator who has not published
    // a Soul profile gets deterministic onboarding, not a 503 on the customer's page.
    let profile: AgentProfile;
    try {
      profile = await this.profileFor(actor);
    } catch (error: unknown) {
      return this.fallbackFromError(request, turnsUsed, error);
    }
    const ids = placeholderIdentity(request.onboardingId, request.step);

    await this.options.authorize?.(actor,profile,request);
    let outcome: EngineOutcome;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      outcome = await this.engine.invoke({
        workspaceId: actor.workspaceId,
        operationId: ids.operationId,
        stepAttemptId: ids.stepAttemptId,
        profile,
        userMessage: buildGuidanceMessage({
          locale: request.locale,
          step: request.step,
          message,
          answers: request.answers ?? [],
          history,
        }),
        // No customer context facts: guidance must not read the consented memory store.
        context: {},
        correlationId: createHash('sha256').update(cacheKey).digest('hex').slice(0, 32),
        priorMessages: [],
      }, { signal: controller.signal });
    } catch (error: unknown) {
      return this.fallbackFromError(request, turnsUsed, error);
    } finally {
      clearTimeout(timer);
    }

    const content = (outcome.content ?? '').trim();
    if (outcome.status === 'FAILED') {
      return this.fallback(request, turnsUsed, 'ENGINE_UNAVAILABLE', true);
    }
    if (content.length === 0) {
      // A completion with no text is not guidance, whatever the transport returned.
      return this.fallback(request, turnsUsed, 'ENGINE_EMPTY', true);
    }
    if (outcome.status !== 'COMPLETED') {
      return this.fallback(request, turnsUsed, 'ENGINE_UNAVAILABLE', true);
    }
    if (looksLikeRefusal(content)) {
      return this.fallback(request, turnsUsed, 'ENGINE_REFUSED', true);
    }

    const result: GuidanceResult = {
      source: 'AI',
      reason: 'OK',
      aiGenerated: true,
      content,
      turn: { role: 'SOUL', content, at: this.now().toISOString(), source: 'AI' },
      turns: { used: turnsUsed, maximum: MAX_GUIDED_TURNS },
      engineAttempted: true,
    };
    this.cache.set(cacheKey, result);
    return result;
  }

  private fallback(request: GuidedRequest, turnsUsed: number, reason: GuidanceReason, engineAttempted: boolean): GuidanceResult {
    const content = fallbackQuestion(request.locale, request.step);
    return {
      source: 'DETERMINISTIC_FALLBACK',
      reason,
      aiGenerated: false,
      content,
      turn: { role: 'SOUL', content, at: this.now().toISOString(), source: 'DETERMINISTIC_FALLBACK' },
      turns: { used: turnsUsed, maximum: MAX_GUIDED_TURNS },
      fallbackQuestion: content,
      engineAttempted,
    };
  }

  private fallbackFromError(request: GuidedRequest, turnsUsed: number, error: unknown): GuidanceResult {
    const reason: GuidanceReason = error instanceof DomainError && error.code === 'NOT_CONFIGURED'
      ? 'ENGINE_NOT_CONFIGURED'
      : (error as { name?: string } | null)?.name === 'AbortError'
        ? 'ENGINE_TIMEOUT'
        : 'ENGINE_UNAVAILABLE';
    return this.fallback(request, turnsUsed, reason, true);
  }
}

/**
 * A refusal must never be presented as guidance. Detection is conservative — an explicit refusal
 * opener only, so ordinary business prose that happens to contain "cannot" still counts as guidance.
 */
export function looksLikeRefusal(content: string): boolean {
  const head = content.slice(0, 120).toLowerCase().trim();
  return /^(i can(?:no|')t (?:help|assist|do that)|i'm (?:sorry|unable)|i am unable|as an ai|je ne peux pas (?:vous )?aider|d[ée]sol[ée],? je ne peux)/.test(head);
}

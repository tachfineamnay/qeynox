/**
 * Pure parsing and classification of the Hermes Agent API-server wire contract.
 *
 * SOURCE OF TRUTH (read from NousResearch/hermes-agent, `gateway/platforms/api_server*.py`):
 *
 * - `POST /v1/chat/completions` is OpenAI-compatible. Auth is `Authorization: Bearer <API_SERVER_KEY>`;
 *   a wrong key is 401 `{error:{type:"gateway_auth_error",code:"gateway_auth_failed"}}`.
 * - A hard agent failure with no usable text is **HTTP 502** with an OpenAI error envelope
 *   `{error:{..., code:"agent_incomplete", hermes:{completed,partial,failed}}}`. It is never a 200.
 * - A soft partial/failed/cancelled turn is HTTP 200 and reported through `finish_reason`:
 *   `"stop"` (normal), `"length"` (truncated or iteration budget exhausted), `"error"` (agent
 *   error), `"cancelled"` (interrupted). Such bodies also carry a `hermes` extras object
 *   `{completed, partial, failed, error, error_code}` where `error_code` is one of
 *   `agent_error`, `output_truncated`, `iteration_budget_exhausted`.
 * - Response headers carry the same facts: `X-Hermes-Completed`, `X-Hermes-Partial`,
 *   `X-Hermes-Error`, `X-Hermes-Session-Id`.
 * - `usage` is always present as `{prompt_tokens,completion_tokens,total_tokens}` and is all zeros
 *   when the runtime did not observe real token counts. Zero is therefore NOT proof of zero tokens.
 * - `GET /health` is unauthenticated `{status:"ok",platform:"hermes-agent",version}`.
 *   `GET /health/detailed`, `/v1/models`, `/v1/toolsets` and `/v1/capabilities` require the bearer key.
 * - The concurrency cap returns **429** `{error:{code:"rate_limit_exceeded"}}` with `Retry-After: 1`.
 * - Server-side cancellation of a non-streaming chat completion is not exposed; only `/v1/runs/{id}/stop`
 *   interrupts run-mode turns, and `finish_reason:"cancelled"` reports an interrupted turn.
 *
 * Everything here is pure so it can be exercised without a network or a model.
 */

/** `finish_reason` values the Hermes API server can emit. */
export type HermesFinishReason = 'stop' | 'length' | 'error' | 'cancelled' | string;

/** `hermes.error_code` values emitted with a soft-partial body. */
export type HermesErrorCode = 'agent_error' | 'output_truncated' | 'iteration_budget_exhausted' | string;

export interface HermesUsage {
  readonly prompt_tokens?: number;
  readonly completion_tokens?: number;
  readonly total_tokens?: number;
}

export interface HermesExtras {
  readonly completed?: boolean;
  readonly partial?: boolean;
  readonly failed?: boolean;
  readonly error?: string | null;
  readonly error_code?: HermesErrorCode | null;
}

export interface HermesChatBody {
  readonly id?: string;
  readonly model?: string;
  readonly choices?: ReadonlyArray<{
    readonly index?: number;
    readonly message?: {
      readonly role?: string;
      readonly content?: string | null;
      readonly reasoning_content?: string | null;
      readonly tool_calls?: readonly unknown[];
      readonly function_call?: unknown;
    };
    readonly finish_reason?: HermesFinishReason | null;
  }>;
  readonly usage?: HermesUsage;
  readonly hermes?: HermesExtras;
}

/** Provider-failure texts Hermes renders into assistant content when no provider is usable. */
const PROVIDER_FAILURE_PATTERNS: readonly RegExp[] = [
  /provider authentication failed/i,
  /no inference provider configured/i,
  /no inference provider available/i,
  /invalid api key|incorrect api key|api key not valid/i,
  // Quota/billing failures are only provider failures when they name the provider surface: a
  // business answer that merely discusses quotas must never be misclassified.
  /insufficient[_ ]quota[^.]{0,40}(?:google|vertex|gemini|project|api)|(?:google|vertex|gemini)[^.]{0,40}insufficient[_ ]quota/i,
  /quota exceeded[^.]{0,40}(?:google|vertex|gemini)|(?:google|vertex|gemini)[^.]{0,40}quota exceeded/i,
  /billing (?:issue|not enabled)[^.]{0,40}(?:google|vertex|gemini|project)|(?:google|vertex|gemini|project)[^.]{0,40}billing (?:issue|not enabled)/i,
  /permission denied.*(?:model|vertex|gemini)/i,
  /google.*(?:credential|service account).*(?:invalid|missing|expired)/i,
];

/**
 * True when assistant text is a provider failure that Hermes surfaced as message content.
 * Kept deliberately narrow: a legitimate answer that merely discusses billing or quotas must not
 * be misclassified, so each pattern requires provider/credential/quota phrasing rather than a
 * bare business word.
 */
export function isProviderFailureText(content: string): boolean {
  return PROVIDER_FAILURE_PATTERNS.some(pattern => pattern.test(content));
}

/** Provider-failure signal that is independent of the text heuristics above. */
export function isProviderFailureSignal(finishReason: HermesFinishReason | undefined, extras: HermesExtras | undefined): boolean {
  if (finishReason === 'error') return true;
  if (extras?.failed === true) return true;
  if (extras?.error_code === 'agent_error') return true;
  return false;
}

export type HermesDisposition =
  /** A usable assistant answer. */
  | 'ANSWER'
  /** Partial answer: report INCOMPLETE, never as a finished result. */
  | 'INCOMPLETE'
  /** The provider/agent failed: the attempt must fail closed. */
  | 'PROVIDER_FAILURE'
  /** The turn was interrupted; the outcome is not a result. */
  | 'CANCELLED'
  /** The runtime asked QeyNox to slow down. */
  | 'RATE_LIMITED';

/**
 * Classify one chat-completions body into a disposition. The precedence matters: a `failed`
 * flag or `finish_reason:"error"` must win over any text, so an error can never be reported as
 * a completed answer.
 */
export function classifyCompletion(input: {
  readonly finishReason?: HermesFinishReason | null;
  readonly extras?: HermesExtras;
  readonly content: string;
}): HermesDisposition {
  const { finishReason, extras, content } = input;
  // `failed` is the only unconditional failure flag. `error_code` is NOT used alone: a cancelled
  // turn also omits `completed` and carries no distinguishing code, so treating `agent_error`
  // as authoritative would misreport an interruption as an agent failure.
  if (extras?.failed === true || finishReason === 'error') return 'PROVIDER_FAILURE';
  if (finishReason === 'cancelled') return 'CANCELLED';
  if (finishReason === 'length' || extras?.partial === true || extras?.error_code === 'output_truncated' || extras?.error_code === 'iteration_budget_exhausted') return 'INCOMPLETE';
  // Older builds render the provider failure as assistant text with finish_reason "stop".
  if (isProviderFailureText(content)) return 'PROVIDER_FAILURE';
  return 'ANSWER';
}

/**
 * Normalize the usage block. Hermes always sends the block, all zeros when it observed nothing,
 * so `reported` is false when every counter is zero or absent. Callers must not record zeros as
 * provider-metered tokens: `reported:false` means "estimate it" or "unknown".
 */
export function normalizeUsage(usage: HermesUsage | undefined): {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly reported: boolean;
} {
  const input = numberOrUndefined(usage?.prompt_tokens);
  const output = numberOrUndefined(usage?.completion_tokens);
  const total = numberOrUndefined(usage?.total_tokens);
  if (total !== undefined && ((input ?? 0) + (output ?? 0) > total)) return { reported: false };
  const reported = Boolean((input ?? 0) > 0 || (output ?? 0) > 0 || (total ?? 0) > 0);
  return reported
    ? { inputTokens: input, outputTokens: output, totalTokens: total, reported: true }
    : { inputTokens: undefined, outputTokens: undefined, totalTokens: undefined, reported: false };
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 2_147_483_647 ? value : undefined;
}

/** The OpenAI-style error envelope, which Hermes also uses for hard failures. */
export interface HermesErrorEnvelope {
  readonly message: string;
  readonly type?: string;
  readonly code?: string;
  readonly extras?: HermesExtras;
}

export function parseErrorEnvelope(value: unknown): HermesErrorEnvelope | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const error = (value as { error?: unknown }).error;
  if (!error || typeof error !== 'object') return undefined;
  const record = error as Record<string, unknown>;
  const message = typeof record.message === 'string' ? record.message : '';
  const hermes = record.hermes;
  const extras = hermes && typeof hermes === 'object'
    ? {
        completed: booleanOrUndefined((hermes as Record<string, unknown>).completed),
        partial: booleanOrUndefined((hermes as Record<string, unknown>).partial),
        failed: booleanOrUndefined((hermes as Record<string, unknown>).failed),
      }
    : undefined;
  return {
    message: message || 'Hermes reported an error',
    type: typeof record.type === 'string' ? record.type : undefined,
    code: typeof record.code === 'string' ? record.code : undefined,
    extras,
  };
}

function booleanOrUndefined(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/** Facts read from response headers, used when the body cannot be parsed. */
export function readCompletionHeaders(headers: {
  get(name: string): string | null;
}): { readonly completed?: boolean; readonly partial?: boolean; readonly errorSummary?: string; readonly sessionId?: string } {
  const flag = (name: string): boolean | undefined => {
    const raw = headers.get(name);
    if (raw === null) return undefined;
    const lowered = raw.trim().toLowerCase();
    return lowered === 'true' ? true : lowered === 'false' ? false : undefined;
  };
  const errorSummary = headers.get('x-hermes-error');
  const sessionId = headers.get('x-hermes-session-id');
  return {
    completed: flag('x-hermes-completed'),
    partial: flag('x-hermes-partial'),
    errorSummary: errorSummary ? redactSecrets(errorSummary, 200) : undefined,
    sessionId: sessionId ?? undefined,
  };
}

/**
 * Remove anything credential-shaped from text that may be surfaced in diagnostics, error
 * messages or logs. Credentials must never leave the process, so this runs on every
 * operator-visible string derived from a remote response.
 */
export function redactSecrets(text: string, limit = 500): string {
  const redacted = text
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '[REDACTED_CREDENTIAL]')
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, '[REDACTED_GOOGLE_KEY]')
    .replace(/\bya29\.[0-9A-Za-z._-]{10,}\b/g, '[REDACTED_GOOGLE_TOKEN]')
    .replace(/"(private_key|client_secret|refresh_token|access_token|api_key|apiKey|authorization)"\s*:\s*"[^"]*"/gi, '"$1":"[REDACTED]"')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, match => (looksLikeOpaqueCredential(match) ? '[REDACTED]' : match));
  return redacted.length > limit ? redacted.slice(0, limit) + '…' : redacted;
}

function looksLikeOpaqueCredential(value: string): boolean {
  // Only long random-looking tokens; prose and identifiers keep their meaning.
  return /^[A-Za-z0-9_-]{32,}$/.test(value) && /[A-Za-z]/.test(value) && /[0-9]/.test(value) && !value.startsWith('hermes-api');
}

/** Network-level failure classification, so retryable conditions are not reported as invalid state. */
export type HermesTransportFailure = 'TIMEOUT' | 'ABORTED' | 'UNREACHABLE' | 'UNAUTHORIZED' | 'RATE_LIMITED' | 'SERVER_ERROR' | 'BAD_REQUEST' | 'MALFORMED';

export function classifyStatus(status: number): HermesTransportFailure | undefined {
  if (status === 401 || status === 403) return 'UNAUTHORIZED';
  if (status === 429) return 'RATE_LIMITED';
  if (status === 400 || status === 404 || status === 422) return 'BAD_REQUEST';
  if (status >= 500) return 'SERVER_ERROR';
  if (status >= 200 && status < 300) return undefined;
  return 'MALFORMED';
}

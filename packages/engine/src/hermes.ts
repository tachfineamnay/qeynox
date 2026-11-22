import { DomainError } from '@qeynox/domain';
import { hermesEndpoint } from './hermes-origin';
import { validHermesTimeout, validVertexModel } from './hermes-settings';
import { classifyProviderFailure } from './hermes-failures';
import {
  classifyCompletion,
  classifyStatus,
  isProviderFailureText,
  normalizeUsage,
  parseErrorEnvelope,
  readCompletionHeaders,
  redactSecrets,
  type HermesChatBody,
} from './hermes-contract';
import type { EngineAvailability, EnginePort, EngineRequest, EngineOutcome, ProposedToolAction } from './types';

export interface HermesConfig {
  baseUrl: string | undefined;
  apiKey: string | undefined;
  model: string;
  timeoutMs: number;
  nativeToolsIsolated: boolean;
  egressAttested: boolean;
  privateOrigin?: string;
  /**
   * Optional Vertex/Gemini routing information. It is NEVER sent as a credential: Hermes owns the
   * Google OAuth2 credential (service-account JSON or ADC) and the provider selection. QeyNox only
   * names the model and, when the deployment uses model routes, the configured alias.
   */
  provider?: 'vertex' | 'gemini' | 'custom';
  vertexRegion?: string;
  /** Operator-visible diagnostics sink. Receives redacted facts only; never credentials. */
  onDiagnostic?: (event: HermesDiagnostic) => void;
}

/** Redacted, structured runtime diagnostic. Never carries a credential or a full prompt. */
export interface HermesDiagnostic {
  readonly phase: 'REQUEST' | 'RESPONSE' | 'FAILURE' | 'CANCELLED' | 'RATE_LIMITED';
  readonly correlationId: string;
  readonly model: string;
  readonly provider?: string;
  /** Origin only: the path is fixed and no query is ever sent. */
  readonly endpointOrigin?: string;
  readonly httpStatus?: number;
  readonly finishReason?: string;
  readonly usageReported?: boolean;
  readonly durationMs?: number;
  readonly errorCode?: string;
  /** Redacted, length-capped remote message. */
  readonly detail?: string;
}

const MAX_MESSAGE_CHARS = 100_000;

export class HermesAdapter implements EnginePort {
  constructor(private readonly config: HermesConfig) {}

  /**
   * Reports exactly what `invoke` would refuse on, without touching the network. The order matches
   * `assertOperational` so the reported reason is the one the caller would actually hit.
   */
  isAvailable(): EngineAvailability {
    if (!this.config.nativeToolsIsolated || !this.config.egressAttested) {
      return { available: false, reason: 'NO_ATTESTATION' };
    }
    if (!this.config.baseUrl) return { available: false, reason: 'NO_ENDPOINT' };
    if (!this.config.apiKey) return { available: false, reason: 'NO_CREDENTIAL' };
    if (!validHermesTimeout(this.config.timeoutMs)) {
      return { available: false, reason: 'INVALID_TIMEOUT' };
    }
    if (!this.config.model || (this.config.provider === 'vertex' && !validVertexModel(this.config.model))) return { available: false, reason: 'INVALID_MODEL' };
    try { this.resolveEndpoint(); } catch { return { available: false, reason: 'INVALID_ENDPOINT' }; }
    return { available: true, reason: 'READY' };
  }

  private diagnostic(event: HermesDiagnostic): void {
    try {
      const scrub = (value: string) => redactSecrets(this.config.apiKey ? value.split(this.config.apiKey).join('[REDACTED]') : value, 200);
      this.config.onDiagnostic?.({ ...event, model: scrub(event.model), correlationId: scrub(event.correlationId),
        provider: event.provider ? scrub(event.provider) : undefined,
        endpointOrigin: event.endpointOrigin ? scrub(event.endpointOrigin) : undefined,
        finishReason: event.finishReason ? scrub(event.finishReason) : undefined,
        errorCode: event.errorCode ? scrub(event.errorCode) : undefined,
        detail: undefined });
    } catch {
      // A diagnostics sink must never break an inference call.
    }
  }

  async invoke(request: EngineRequest, options?: { signal?: AbortSignal }): Promise<EngineOutcome> {
    this.assertOperational();
    this.assertModel();
    const url = this.resolveEndpoint();
    const started = Date.now();
    const ac = new AbortController();
    let timedOut = false;
    const forwardAbort = () => ac.abort();
    // An already-aborted caller signal must not start a request that will be ignored.
    if (options?.signal?.aborted) throw new DomainError('INVALID_STATE', 'Hermes request was cancelled before dispatch; no provider call was made');
    options?.signal?.addEventListener('abort', forwardAbort, { once: true });
    const timeout = setTimeout(() => { timedOut = true; ac.abort(); }, this.config.timeoutMs);
    const correlationId = request.correlationId;
    try {
      const body = this.buildBody(request);
      this.diagnostic({
        phase: 'REQUEST', correlationId, model: this.config.model, provider: this.config.provider,
        endpointOrigin: new URL(url).origin,
      });
      const response = await fetch(url, {
        method: 'POST',
        signal: ac.signal,
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + this.config.apiKey },
        body: JSON.stringify(body),
        redirect: 'error',
      });
      const payload = await this.readJson(response, correlationId, started);
      if (!response.ok) this.throwForStatus(response, correlationId, started, payload);
      const outcome = this.interpret(payload, response.headers, correlationId, started);
      this.diagnostic({
        phase: 'RESPONSE', correlationId, model: this.config.model, provider: this.config.provider,
        httpStatus: response.status, finishReason: outcome.reason, usageReported: outcome.usage !== undefined,
        durationMs: Date.now() - started,
      });
      return outcome;
    } catch (error: unknown) {
      if (error instanceof DomainError) {
        this.diagnostic({ phase: 'FAILURE', correlationId, model: this.config.model, provider: this.config.provider, errorCode: error.context?.hermesFailure ?? error.code, durationMs: Date.now() - started });
        throw error;
      }
      // Distinguish a timeout from a caller cancellation: they imply different operator actions.
      if (ac.signal.aborted) {
        const code = timedOut ? 'TIMEOUT' : 'CANCELLED';
        this.diagnostic({
          phase: timedOut ? 'FAILURE' : 'CANCELLED', correlationId, model: this.config.model,
          provider: this.config.provider, errorCode: code, durationMs: Date.now() - started,
        });
        throw new DomainError(
          'UNAVAILABLE',
          timedOut
            ? 'Hermes request timed out after ' + this.config.timeoutMs + 'ms; server-side cancellation is unconfirmed'
            : 'Hermes request was cancelled; server-side cancellation is unconfirmed',
          { hermesFailure: code },
        );
      }
      this.diagnostic({
        phase: 'FAILURE', correlationId, model: this.config.model, provider: this.config.provider,
        errorCode: 'UNREACHABLE', durationMs: Date.now() - started,
        detail: 'Private endpoint request failed',
      });
      throw new DomainError('UNAVAILABLE', 'Hermes endpoint is unreachable', { hermesFailure: 'UNREACHABLE' });
    } finally {
      clearTimeout(timeout);
      options?.signal?.removeEventListener('abort', forwardAbort);
    }
  }

  /**
   * Deployment isolation is the only real control over Hermes' built-in tools: no request-time
   * prompt can enforce ToolBroker. Fail closed unless the operator attests both native-tool
   * isolation and egress containment.
   */
  private assertOperational(): void {
    if (!this.config.nativeToolsIsolated || !this.config.egressAttested) {
      throw new DomainError('NOT_CONFIGURED', 'Hermes native-tool isolation and egress attestation are required before tenant execution');
    }
    if (!this.config.baseUrl || !this.config.apiKey) {
      throw new DomainError('NOT_CONFIGURED', 'Hermes endpoint and API key are required');
    }
    if (!validHermesTimeout(this.config.timeoutMs)) {
      throw new DomainError('NOT_CONFIGURED', 'Hermes request timeout must be an integer between 250 and 120000 milliseconds');
    }
  }

  private assertModel(): void {
    if (!this.config.model || (this.config.provider === 'vertex' && !validVertexModel(this.config.model))) {
      throw new DomainError('NOT_CONFIGURED', 'Explicit google/gemini model required for Vertex routing', { hermesFailure: 'PROVIDER_CONFIGURATION' });
    }
  }

  private resolveEndpoint(): string {
    try {
      return hermesEndpoint(this.config.baseUrl!, this.config.privateOrigin);
    } catch {
      throw new DomainError('DENIED', 'Hermes endpoint is not explicitly authorized');
    }
  }

  private buildBody(request: EngineRequest): Record<string, unknown> {
    if (!Number.isSafeInteger(request.profile.maxOutputTokens) || request.profile.maxOutputTokens < 1) throw new DomainError('INVALID_INPUT', 'Profile output token budget must be a positive integer');
    const safeContext = Object.fromEntries(
      Object.entries(request.context).filter(([key]) => request.profile.permittedContextKeys.includes(key)),
    );
    const systemInstructions = [
      request.profile.systemInstructions,
      'You may propose external tool requests only as JSON objects; never claim to have invoked one.',
      'All external tools are provided by QeyNox after policy review. Never use terminal, filesystem, browser or built-in tools.',
      'Business research must clearly separate verified evidence from uncertainty. Do not invent suppliers, citations or prices.',
      'Allowed QeyNox broker tool names: ' + request.profile.allowedTools.join(', '),
    ].join('\n');
    const messages = [
      { role: 'system', content: systemInstructions },
      ...((request.priorMessages ?? []).slice(-20)),
      { role: 'user', content: JSON.stringify({ task: request.userMessage, context: safeContext, correlationId: request.correlationId }) },
    ];
    const userChars = messages.reduce((total, message) => total + message.content.length, 0);
    if (userChars > MAX_MESSAGE_CHARS) {
      throw new DomainError('INVALID_INPUT', 'Hermes request exceeds the maximum message size');
    }
    // `max_tokens` is capped by the profile. Thinking-capable Gemini models spend part of this
    // budget on reasoning, so the profile value is a ceiling, not a guarantee of visible output.
    return {
      model: this.config.model,
      messages,
      stream: false,
      max_tokens: Math.min(8192, request.profile.maxOutputTokens),
    };
  }

  private throwForStatus(response: Response, correlationId: string, started: number, payload: unknown): never {
    const failure = classifyStatus(response.status);
    const envelope = parseErrorEnvelope(payload);
    const providerFailure = failure === 'SERVER_ERROR' && envelope?.code === 'agent_incomplete'
      ? classifyProviderFailure(envelope.extras?.error ?? envelope.message) : undefined;
    this.diagnostic({
      phase: failure === 'RATE_LIMITED' ? 'RATE_LIMITED' : 'FAILURE',
      correlationId, model: this.config.model, provider: this.config.provider,
      httpStatus: response.status, durationMs: Date.now() - started,
      errorCode: providerFailure ?? failure ?? 'HTTP_ERROR',
    });
    if (failure === 'UNAUTHORIZED') {
      throw new DomainError('NOT_CONFIGURED', 'Hermes rejected the API key (HTTP ' + response.status + ')', { hermesFailure: 'UNAUTHORIZED' });
    }
    if (failure === 'RATE_LIMITED') {
      const rawRetryAfter = response.headers.get('retry-after');
      const retryAfter = rawRetryAfter && /^\d{1,4}$/.test(rawRetryAfter) ? rawRetryAfter : undefined;
      throw new DomainError('UNAVAILABLE', 'Hermes is at its concurrency limit; retry later', {
        hermesFailure: 'RATE_LIMITED', ...(retryAfter ? { retryAfter } : {}),
      });
    }
    if (failure === 'SERVER_ERROR') {
      // HTTP 502 with code `agent_incomplete` is the documented hard-failure path.
      throw new DomainError('UNAVAILABLE', 'Hermes reported a failed agent run (HTTP ' + response.status + ')', { hermesFailure: providerFailure ?? 'SERVER_ERROR' });
    }
    throw new DomainError('INVALID_STATE', 'Hermes rejected the request (HTTP ' + response.status + ')', { hermesFailure: failure ?? 'BAD_REQUEST' });
  }

  private async readJson(response: Response, correlationId: string, started: number): Promise<unknown> {
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > 2 * 1024 * 1024) {
          await reader.cancel();
          throw new DomainError('INVALID_STATE', 'Hermes response exceeds the bounded response size', { hermesFailure: 'MALFORMED' });
        }
        chunks.push(next.value);
      }
    } finally { reader.releaseLock(); }
    const raw = Buffer.concat(chunks).toString('utf8');
    try {
      return raw.length ? JSON.parse(raw) : null;
    } catch {
      if (!response.ok) return null; // Status still classifies a non-JSON upstream error.
      this.diagnostic({ phase: 'FAILURE', correlationId, model: this.config.model, provider: this.config.provider, httpStatus: response.status, durationMs: Date.now() - started, errorCode: 'MALFORMED' });
      throw new DomainError('INVALID_STATE', 'Hermes returned a body that is not valid JSON', { hermesFailure: 'MALFORMED' });
    }
  }

  private interpret(payload: unknown, responseHeaders: Headers, correlationId: string, started: number): EngineOutcome {
    const envelope = parseErrorEnvelope(payload);
    if (envelope) {
      // A 2xx body carrying an error envelope is still a failure, never a result.
      this.diagnostic({
        phase: 'FAILURE', correlationId, model: this.config.model, provider: this.config.provider,
        errorCode: 'ERROR_ENVELOPE', durationMs: Date.now() - started,
      });
      throw new DomainError('INVALID_STATE', 'Hermes returned an error envelope instead of a completion', { hermesFailure: 'MALFORMED' });
    }
    const wire = payload as HermesChatBody | null;
    const choice = wire?.choices?.[0];
    if (!choice) throw new DomainError('INVALID_STATE', 'Hermes returned no choice', { hermesFailure: 'MALFORMED' });
    // A native tool call cannot be mediated by ToolBroker; never treat it as agent output.
    if (choice.message?.tool_calls?.length || choice.message?.function_call || choice.finish_reason === 'tool_calls' || choice.finish_reason === 'function_call') {
      throw new DomainError('DENIED', 'Hermes returned a native tool call; QeyNox requires ToolBroker mediation', { hermesFailure: 'NATIVE_TOOLS_DETECTED' });
    }
    const content = choice.message?.content;
    if (typeof content !== 'string') throw new DomainError('INVALID_STATE', 'Hermes returned no text content', { hermesFailure: 'MALFORMED' });

    const rawFinishReason = choice.finish_reason;
    const finishReason = typeof rawFinishReason === 'string' ? (['stop', 'length', 'error', 'cancelled', 'tool_calls', 'function_call'].includes(rawFinishReason) ? rawFinishReason : 'unknown_finish_reason') : undefined;
    const extras = wire?.hermes;
    const disposition = classifyCompletion({ finishReason, extras, content });
    const headerFacts = readCompletionHeaders(responseHeaders);

    if (disposition === 'PROVIDER_FAILURE') {
      const detail = extras?.error ?? headerFacts.errorSummary ?? content;
      const failure = classifyProviderFailure(detail);
      this.diagnostic({
        phase: 'FAILURE', correlationId, model: this.config.model, provider: this.config.provider,
        finishReason, errorCode: failure, durationMs: Date.now() - started,
      });
      // The narrow text heuristics are kept for older builds that rendered the failure as content;
      // the structured flags above are authoritative for current builds.
      if (isProviderFailureText(content)) {
        throw new DomainError('INVALID_STATE', 'Hermes has no usable inference provider', { hermesFailure: failure });
      }
      throw new DomainError('UNAVAILABLE', 'Hermes reported a failed agent run', { hermesFailure: failure });
    }
    if (disposition === 'CANCELLED') {
      this.diagnostic({
        phase: 'CANCELLED', correlationId, model: this.config.model, provider: this.config.provider,
        finishReason, durationMs: Date.now() - started,
      });
      throw new DomainError('INVALID_STATE', 'Hermes reported an interrupted turn; no result was produced', { hermesFailure: 'CANCELLED' });
    }
    if (disposition === 'INCOMPLETE' && content.trim().length === 0) {
      throw new DomainError('INVALID_STATE', 'Hermes returned an empty partial response', { hermesFailure: 'INCOMPLETE' });
    }

    if (!content.trim()) throw new DomainError('INVALID_STATE', 'Hermes returned an empty answer', { hermesFailure: 'MALFORMED' });
    const { content: text, proposedTools } = parseProposals(content);
    const usage = normalizeUsage(wire?.usage);
    return {
      status: disposition === 'INCOMPLETE' ? 'INCOMPLETE' : finishReason === 'stop' || finishReason === undefined ? 'COMPLETED' : 'INCOMPLETE',
      engine: 'hermes',
      engineRunId: typeof wire?.id === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(wire.id) ? wire.id : undefined,
      content: text,
      proposedTools,
      usage: usage.reported
        ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens: usage.totalTokens }
        : undefined,
      reason: finishReason ?? (disposition === 'INCOMPLETE' ? 'partial' : undefined),
      receivedAt: new Date().toISOString(),
    };
  }
}

function parseProposals(body: string): { content: string; proposedTools: ProposedToolAction[] } {
  try {
    const json = JSON.parse(body) as Record<string, unknown>;
    if (!json || json.kind !== 'tool_proposals' || !Array.isArray(json.actions)) return { content: body, proposedTools: [] };
    const proposals: ProposedToolAction[] = [];
    for (const value of json.actions.slice(0, 20)) {
      if (!value || typeof value !== 'object') continue;
      const action = value as Record<string, unknown>;
      if (typeof action.connectorId === 'string' && typeof action.toolName === 'string' && typeof action.version === 'string' && typeof action.reason === 'string') {
        proposals.push({ connectorId: action.connectorId, toolName: action.toolName, version: action.version, reason: action.reason, input: action.input });
      }
    }
    return { content: typeof json.summary === 'string' ? json.summary : 'Tool proposals awaiting QeyNox authorization', proposedTools: proposals };
  } catch {
    return { content: body, proposedTools: [] };
  }
}

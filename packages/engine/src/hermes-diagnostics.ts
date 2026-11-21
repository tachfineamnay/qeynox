import { DomainError } from '@qeynox/domain';
import { hermesEndpoint } from './hermes-origin';
import { parseErrorEnvelope, redactSecrets } from './hermes-contract';

/**
 * Read-only runtime diagnostics for the Hermes deployment.
 *
 * The probe reports facts the deployment itself exposes; it never invents them and never returns a
 * credential. Every string that originates remotely is redacted before it can reach an operator
 * screen, a log line or an error message.
 *
 * Contract read from NousResearch/hermes-agent (`gateway/platforms/api_server.py`):
 * - `GET /health` is unauthenticated: `{status:"ok",platform:"hermes-agent",version}`.
 * - `GET /health/detailed` requires the bearer key and reports gateway state and active agents.
 * - `GET /v1/models` requires the bearer key and lists `hermes-agent` plus configured model routes.
 * - `GET /v1/toolsets` requires the bearer key; each entry exposes `enabled`, `configured`, `tools`.
 *   With `platform_toolsets.api_server: []` every entry must be `enabled:false`; that is the
 *   native-tool isolation evidence QeyNox requires.
 */
export interface HermesEndpointConfig {
  readonly baseUrl: string | undefined;
  readonly apiKey: string | undefined;
  readonly privateOrigin?: string;
  readonly timeoutMs?: number;
  /**
   * MISSION A21.07: an external deadline. When it aborts, every outstanding request is cancelled, so
   * a caller can bound the whole probe (not only each request) to one time budget.
   */
  readonly signal?: AbortSignal;
}

export interface HermesDiagnosticReport {
  readonly reachable: boolean;
  readonly endpointOrigin: string | null;
  /** Version string reported by `/health`; never guessed. */
  readonly runtimeVersion: string | null;
  readonly platform: string | null;
  readonly authenticated: boolean;
  /** MISSION A21.07: true only when Hermes answered the authenticated inventory with 401/403. */
  readonly authRejected?: boolean;
  /** Advertised model ids from `/v1/models` (no credentials, no upstream keys). */
  readonly models: readonly string[] | null;
  /** Configured model, as the deployment advertises it. */
  readonly activeModel?: string;
  readonly activeModelAdvertised: boolean | null;
  /** `true` only when every API-server toolset reports `enabled:false`. */
  readonly nativeToolsIsolated: boolean | null;
  readonly toolsets: readonly HermesToolsetState[] | null;
  readonly failures: readonly string[];
}

export interface HermesToolsetState {
  readonly name: string;
  readonly enabled: boolean;
  readonly configured: boolean;
  readonly toolCount: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Probe one deployment. `nativeToolsIsolated` is reported as `null` when the toolset inventory
 * cannot be read: unknown is not the same as isolated.
 */
export async function probeHermes(config: HermesEndpointConfig & { model?: string }): Promise<HermesDiagnosticReport> {
  const failures: string[] = [];
  if (!config.baseUrl) {
    return emptyReport(['HERMES_API_BASE_URL is not set']);
  }
  let origin: string;
  let healthUrl: string;
  try {
    const chat = new URL(hermesEndpoint(config.baseUrl, config.privateOrigin));
    origin = chat.origin;
    healthUrl = new URL('health', chat.origin + '/').href;
  } catch {
    return emptyReport(['HERMES_API_BASE_URL is not an authorized origin']);
  }
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const signal = config.signal;
  const health = await get(healthUrl, undefined, timeoutMs, signal);
  if (health.kind !== 'ok') {
    return {
      ...emptyReport([describeFailure('health', health)]),
      endpointOrigin: origin,
    };
  }
  const healthBody = health.json as { status?: unknown; platform?: unknown; version?: unknown } | null;
  const status = typeof healthBody?.status === 'string' ? healthBody.status : null;
  const platform = typeof healthBody?.platform === 'string' ? healthBody.platform : null;
  const runtimeVersion = typeof healthBody?.version === 'string' ? healthBody.version : null;
  if (status !== 'ok') failures.push('health endpoint did not report status "ok"');

  if (!config.apiKey) {
    return {
      reachable: true, endpointOrigin: origin, runtimeVersion, platform, authenticated: false,
      models: null, activeModelAdvertised: null, nativeToolsIsolated: null, toolsets: null,
      failures: [...failures, 'HERMES_API_KEY is not set; authenticated diagnostics were not attempted'],
    };
  }

  const modelsUrl = new URL('v1/models', origin + '/').href;
  const models = await get(modelsUrl, config.apiKey, timeoutMs, signal);
  let modelIds: string[] | null = null;
  let authenticated = false;
  let authRejected = false;
  if (models.kind === 'ok') {
    authenticated = true;
    const body = models.json as { data?: ReadonlyArray<{ id?: unknown }> } | null;
    modelIds = Array.isArray(body?.data)
      ? body.data.flatMap(entry => (typeof entry?.id === 'string' ? [entry.id] : []))
      : [];
  } else if (models.kind === 'status' && (models.status === 401 || models.status === 403)) {
    authRejected = true;
    failures.push('Hermes rejected the API key (HTTP ' + models.status + ')');
  } else {
    failures.push(describeFailure('model inventory', models));
  }

  const toolsetsUrl = new URL('v1/toolsets', origin + '/').href;
  const toolsets = await get(toolsetsUrl, config.apiKey, timeoutMs, signal);
  let toolsetState: HermesToolsetState[] | null = null;
  let nativeToolsIsolated: boolean | null = null;
  if (toolsets.kind === 'ok') {
    const body = toolsets.json as { data?: ReadonlyArray<Record<string, unknown>> } | null;
    if (Array.isArray(body?.data)) {
      toolsetState = body.data.map(entry => ({
        name: typeof entry.name === 'string' ? entry.name : 'unknown',
        enabled: entry.enabled === true,
        configured: entry.configured === true,
        toolCount: Array.isArray(entry.tools) ? entry.tools.length : 0,
      }));
      // Isolation evidence: the API-server surface exposes no enabled toolset at all.
      nativeToolsIsolated = toolsetState.every(entry => !entry.enabled);
    } else {
      failures.push('toolset inventory was not in the documented shape');
    }
  } else {
    failures.push(describeFailure('toolset inventory', toolsets));
  }

  const activeModel = config.model;
  return {
    reachable: true,
    endpointOrigin: origin,
    runtimeVersion,
    platform,
    authenticated,
    authRejected,
    models: modelIds,
    activeModel,
    activeModelAdvertised: modelIds && activeModel ? modelIds.includes(activeModel) : null,
    nativeToolsIsolated,
    toolsets: toolsetState,
    failures,
  };
}

function emptyReport(failures: readonly string[]): HermesDiagnosticReport {
  return {
    reachable: false, endpointOrigin: null, runtimeVersion: null, platform: null, authenticated: false,
    models: null, activeModelAdvertised: null, nativeToolsIsolated: null, toolsets: null, failures,
  };
}

type ProbeResult =
  | { readonly kind: 'ok'; readonly status: number; readonly json: unknown }
  | { readonly kind: 'status'; readonly status: number; readonly json: unknown }
  | { readonly kind: 'error'; readonly detail: string };

/**
 * A pooled keep-alive connection to a Hermes that has since restarted fails on first use. That says
 * nothing about the deployment, so the idempotent GET is retried once on a fresh connection, inside the
 * same deadline. Every other failure is reported as observed.
 */
const STALE_CONNECTION_CODES = new Set(['UND_ERR_SOCKET', 'ECONNRESET', 'UND_ERR_CLOSED', 'EPIPE']);

function causeCode(error: unknown): string | null {
  const cause = error instanceof Error ? (error as Error & { cause?: { code?: unknown } }).cause : undefined;
  return cause && typeof cause.code === 'string' ? cause.code : null;
}

async function get(url: string, apiKey: string | undefined, timeoutMs: number, signal?: AbortSignal): Promise<ProbeResult> {
  try {
    const deadline = signal ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal]) : AbortSignal.timeout(timeoutMs);
    const init: RequestInit = { method: 'GET', redirect: 'error', signal: deadline, headers: apiKey ? { authorization: 'Bearer ' + apiKey } : {} };
    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (error: unknown) {
      if (deadline.aborted || !STALE_CONNECTION_CODES.has(causeCode(error) ?? '')) throw error;
      response = await fetch(url, init);
    }
    const raw = await response.text();
    let json: unknown = null;
    try { json = raw.length ? JSON.parse(raw) : null; } catch { json = null; }
    if (!response.ok) return { kind: 'status', status: response.status, json };
    return { kind: 'ok', status: response.status, json };
  } catch (error: unknown) {
    return { kind: 'error', detail: redactSecrets(error instanceof Error ? error.message : String(error), 200) };
  }
}

function describeFailure(label: string, result: ProbeResult): string {
  if (result.kind === 'error') return label + ' probe failed: ' + result.detail;
  if (result.kind === 'status') {
    const envelope = parseErrorEnvelope(result.json);
    const code = envelope?.code ?? envelope?.type ?? 'HTTP_' + result.status;
    return label + ' returned HTTP ' + result.status + ' (' + code + ')';
  }
  return label + ' probe returned an unexpected result';
}

/**
 * Diagnostics for the operator surface: reports the reason an inference call cannot run, using
 * only configuration names and never their values.
 */
export function describeInferenceBlockers(input: {
  readonly baseUrl: string | undefined;
  readonly apiKey: string | undefined;
  readonly nativeToolsIsolated: boolean;
  readonly egressAttested: boolean;
}): readonly string[] {
  const blockers: string[] = [];
  if (!input.baseUrl) blockers.push('HERMES_API_BASE_URL');
  if (!input.apiKey) blockers.push('HERMES_API_KEY');
  if (!input.nativeToolsIsolated) blockers.push('HERMES_NATIVE_TOOLS_ISOLATED=true');
  if (!input.egressAttested) blockers.push('QEYNOX_NETWORK_POLICY_ATTESTED=true');
  return blockers;
}

/**
 * Assert that a diagnostic report supports enabling tenant execution. `nativeToolsIsolated` must
 * be observed `true`; a missing inventory is refused, never assumed.
 */
export function requireIsolationEvidence(report: HermesDiagnosticReport): void {
  if (!report.reachable) throw new DomainError('UNAVAILABLE', 'Hermes is not reachable for isolation evidence');
  if (report.nativeToolsIsolated !== true) {
    throw new DomainError(
      'NOT_CONFIGURED',
      'Native-tool isolation is not evidenced: ' + (report.nativeToolsIsolated === null
        ? 'the toolset inventory could not be read'
        : 'the API server still exposes enabled toolsets'),
    );
  }
}

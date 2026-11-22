import { createHash, randomUUID } from 'node:crypto';
import { hermesEndpoint, probeHermes, redactSecrets, validVertexModel, validHermesTimeout } from '@qeynox/engine';
import { probeHatchet, resolveHatchetEndpoints } from '@qeynox/orchestration';
import {
  combineRuntimeReadiness, evaluateRuntimeComponent, failClosedRuntime,
  type RuntimeComponent, type RuntimeComponentId, type RuntimeIdentity, type RuntimeProbeEvidence, type RuntimeProbeFailure, type RuntimeReadiness,
} from './runtime-readiness';

/**
 * MISSION A21.07 — bounded live probes of the runtime components.
 *
 * Each component (Hermes, Hatchet) has a `RuntimeProbeDefinition` that reads the current
 * configuration and knows how to probe the real deployment. `RuntimeProbeMonitor` runs the probes
 * independently, under one deadline per probe, and keeps the latest evidence per component in memory.
 *
 * Deliberate properties:
 * - Evidence lives only in the memory of the process that produced it. A restarted process starts
 *   with no evidence (NOT_PROBED) and must probe again; nothing persisted or configured is trusted.
 * - One component's failure, timeout or exception never touches the other component's evidence.
 * - Evidence carries no credential: probes report codes, origins and versions, and every recorded
 *   string is scrubbed of the configured secret values before it is stored.
 */
export interface RuntimeProbeTarget {
  /** Endpoint origin that will be probed (no path, no credentials). */
  readonly endpoint: string;
  /** Digest binding evidence to this exact configuration (endpoint + credential digest). */
  readonly fingerprint: string;
}

export interface RuntimeProbeConfiguration {
  readonly missing: readonly string[];
  readonly attested: boolean;
  /** Null when there is nothing concrete to probe. */
  readonly target: RuntimeProbeTarget | null;
}

export type RuntimeProbeAttempt =
  | { readonly ok: true; readonly identity: RuntimeIdentity }
  | { readonly ok: false; readonly failure: RuntimeProbeFailure; readonly detail: string };

export interface RuntimeProbeDefinition {
  readonly component: RuntimeComponentId;
  configuration(): RuntimeProbeConfiguration;
  /** Probe the configured deployment. Must honour `signal`; the monitor bounds it regardless. */
  probe(signal: AbortSignal): Promise<RuntimeProbeAttempt>;
  /** Configured secret values that must never appear in recorded evidence. */
  secrets(): readonly string[];
}

export interface RuntimeProbePolicy {
  /** Upper bound for one complete probe of one component. */
  readonly timeoutMs: number;
  /** Evidence older than this proves nothing (expiresAt = observedAt + freshnessMs). */
  readonly freshnessMs: number;
  /** Background re-probe period; always shorter than the freshness limit. */
  readonly intervalMs: number;
}

function boundedNumber(raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = raw === undefined || raw.trim() === '' ? fallback : Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * Probe policy from the environment, clamped so a misconfiguration cannot make evidence immortal or a
 * probe unbounded:
 * - QEYNOX_RUNTIME_PROBE_TIMEOUT_MS: default 5000, clamped to 250..15000.
 * - QEYNOX_RUNTIME_PROBE_FRESHNESS_SECONDS: default 120, clamped to 10..900.
 * - QEYNOX_RUNTIME_PROBE_INTERVAL_SECONDS: default 30, clamped to 5..(freshness / 2).
 */
export function runtimeProbePolicyFromEnv(env: NodeJS.ProcessEnv = process.env): RuntimeProbePolicy {
  const timeoutMs = boundedNumber(env.QEYNOX_RUNTIME_PROBE_TIMEOUT_MS, 5_000, 250, 15_000);
  const freshnessSeconds = boundedNumber(env.QEYNOX_RUNTIME_PROBE_FRESHNESS_SECONDS, 120, 10, 900);
  const intervalSeconds = boundedNumber(env.QEYNOX_RUNTIME_PROBE_INTERVAL_SECONDS, 30, 5, Math.max(5, Math.floor(freshnessSeconds / 2)));
  return { timeoutMs, freshnessMs: freshnessSeconds * 1000, intervalMs: intervalSeconds * 1000 };
}

function digest(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 32);
}

const MAX_DETAIL = 240;

function scrub(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 4) out = out.split(secret).join('[REDACTED]');
  }
  return redactSecrets(out, MAX_DETAIL);
}

/**
 * Identity fields are structured values (configured origin, validated version, the tenant id the token
 * names), not remote free text, so only exact configured secrets are removed. The heuristic in
 * `redactSecrets` would erase a tenant UUID and with it the very identity being proven.
 */
function scrubIdentity(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 4) out = out.split(secret).join('[REDACTED]');
  }
  return out.slice(0, MAX_DETAIL);
}

export interface RuntimeProbeMonitorOptions {
  readonly now?: () => Date;
  readonly newId?: () => string;
}

export class RuntimeProbeMonitor {
  private readonly evidenceByComponent = new Map<RuntimeComponentId, RuntimeProbeEvidence>();
  private readonly inflight = new Map<RuntimeComponentId, Promise<RuntimeProbeEvidence | null>>();
  private readonly definitions = new Map<RuntimeComponentId, RuntimeProbeDefinition>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(definitions: readonly RuntimeProbeDefinition[], readonly policy: RuntimeProbePolicy, options: RuntimeProbeMonitorOptions = {}) {
    if (!(policy.timeoutMs > 0) || !(policy.freshnessMs > 0) || !(policy.intervalMs > 0)) throw new Error('Runtime probe policy must be positive');
    for (const definition of definitions) {
      if (this.definitions.has(definition.component)) throw new Error('Duplicate runtime probe definition: ' + definition.component);
      this.definitions.set(definition.component, definition);
    }
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? randomUUID;
  }

  /** Latest evidence for one component, or null (never probed in this process, or unconfigured). */
  evidence(component: RuntimeComponentId): RuntimeProbeEvidence | null {
    return this.evidenceByComponent.get(component) ?? null;
  }

  /** Evaluate both components against the current configuration and clock. */
  readiness(): RuntimeReadiness {
    const now = this.now();
    const component = (id: RuntimeComponentId, fallback: RuntimeComponent): RuntimeComponent => {
      const definition = this.definitions.get(id);
      if (!definition) return fallback;
      const configuration = definition.configuration();
      return evaluateRuntimeComponent({
        id,
        missing: configuration.missing,
        attested: configuration.attested,
        targetFingerprint: configuration.target?.fingerprint ?? null,
        evidence: this.evidence(id),
        now,
      });
    };
    const closed = failClosedRuntime();
    return combineRuntimeReadiness(component('hermes', closed.engine), component('hatchet', closed.orchestrator));
  }

  /** Probe one component now. Concurrent calls share the in-flight probe. */
  probe(component: RuntimeComponentId): Promise<RuntimeProbeEvidence | null> {
    const running = this.inflight.get(component);
    if (running) return running;
    const task = this.run(component).finally(() => this.inflight.delete(component));
    this.inflight.set(component, task);
    return task;
  }

  /** Probe every component independently; one failure never prevents or alters another. */
  async probeAll(): Promise<void> {
    await Promise.allSettled([...this.definitions.keys()].map(component => this.probe(component)));
  }

  /**
   * Readiness, re-probing first any component that is not currently VERIFIED (bounded by the probe
   * timeout). Used by the worker right before it would execute a step.
   */
  async freshReadiness(): Promise<RuntimeReadiness> {
    const current = this.readiness();
    const stale = [current.engine, current.orchestrator]
      .filter(component => component.verification.status !== 'VERIFIED' && component.verification.status !== 'NOT_CONFIGURED')
      .map(component => component.id as RuntimeComponentId)
      .filter(id => this.definitions.has(id));
    if (stale.length) await Promise.allSettled(stale.map(id => this.probe(id)));
    return this.readiness();
  }

  /** Start background probing (immediately, then every `intervalMs`). The timer never keeps the process alive. */
  start(): void {
    if (this.timer) return;
    void this.probeAll();
    this.timer = setInterval(() => { void this.probeAll(); }, this.policy.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async run(component: RuntimeComponentId): Promise<RuntimeProbeEvidence | null> {
    const definition = this.definitions.get(component);
    if (!definition) return null;
    const configuration = definition.configuration();
    if (!configuration.target) {
      // Nothing to probe: drop any evidence so a later configuration must be verified from scratch.
      this.evidenceByComponent.delete(component);
      return null;
    }
    const target = configuration.target;
    const started = this.now();
    const startedClock = Date.now();
    const controller = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<RuntimeProbeAttempt>(resolve => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        resolve({ ok: false, failure: 'TIMEOUT', detail: 'no complete answer within ' + this.policy.timeoutMs + ' ms' });
      }, this.policy.timeoutMs);
    });
    let attempt: RuntimeProbeAttempt;
    try {
      attempt = await Promise.race([
        definition.probe(controller.signal).catch((error: unknown): RuntimeProbeAttempt => ({
          ok: false, failure: 'PROBE_ERROR', detail: error instanceof Error ? error.message : 'probe threw a non-error value',
        })),
        deadline,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      if (!controller.signal.aborted) controller.abort();
    }
    if (timedOut && !attempt.ok) attempt = { ok: false, failure: 'TIMEOUT', detail: 'no complete answer within ' + this.policy.timeoutMs + ' ms' };
    const observed = this.now();
    const secrets = definition.secrets();
    const evidence: RuntimeProbeEvidence = {
      component,
      evidenceRef: 'probe:' + component + ':' + this.newId(),
      targetFingerprint: target.fingerprint,
      endpoint: target.endpoint,
      outcome: attempt.ok ? 'SUCCEEDED' : 'FAILED',
      failure: attempt.ok ? null : attempt.failure,
      detail: attempt.ok ? null : scrub(attempt.detail, secrets),
      identity: attempt.ok ? {
        endpoint: scrubIdentity(attempt.identity.endpoint, secrets),
        deployment: scrubIdentity(attempt.identity.deployment, secrets),
        version: scrubIdentity(attempt.identity.version, secrets),
      } : null,
      startedAt: started.toISOString(),
      observedAt: observed.toISOString(),
      expiresAt: new Date(observed.getTime() + this.policy.freshnessMs).toISOString(),
      durationMs: Math.max(0, Date.now() - startedClock),
    };
    this.evidenceByComponent.set(component, evidence);
    return evidence;
  }
}

/** Hermes: reachable, healthy, really Hermes, key accepted, native tools isolated, model advertised. */
export function hermesProbeDefinition(env: NodeJS.ProcessEnv = process.env): RuntimeProbeDefinition {
  const read = () => {
    const baseUrl = (env.HERMES_API_BASE_URL ?? '').trim();
    const apiKey = (env.HERMES_API_KEY ?? '').trim();
    const privateOrigin = env.HERMES_PRIVATE_ORIGIN?.trim() || undefined;
    const provider = env.HERMES_PROVIDER?.trim() ?? '';
    const model = (env.HERMES_MODEL ?? '').trim() || (provider === 'vertex' ? '' : 'hermes-agent');
    const timeoutMs = Number(env.HERMES_REQUEST_TIMEOUT_MS ?? 60_000);
    let origin: string | null = null;
    if (baseUrl) {
      try { origin = new URL(hermesEndpoint(baseUrl, privateOrigin)).origin; } catch { origin = null; }
    }
    return { baseUrl, apiKey, privateOrigin, model, origin, provider, timeoutMs };
  };
  return {
    component: 'hermes',
    configuration() {
      const { baseUrl, apiKey, privateOrigin, model, origin, provider, timeoutMs } = read();
      const missing: string[] = [];
      if (!baseUrl) missing.push('HERMES_API_BASE_URL');
      else if (!origin) missing.push('HERMES_API_BASE_URL (origin not authorized: use https, a local host or HERMES_PRIVATE_ORIGIN)');
      if (!apiKey) missing.push('HERMES_API_KEY');
      if (provider && !['vertex', 'gemini', 'custom'].includes(provider)) missing.push('HERMES_PROVIDER (unsupported)');
      if (provider === 'vertex' && !validVertexModel(model)) missing.push('HERMES_MODEL (explicit google/gemini model required)');
      if (!validHermesTimeout(timeoutMs)) missing.push('HERMES_REQUEST_TIMEOUT_MS (250..120000 integer required)');
      // Operator attestations remain REQUIRED, but they are preconditions only: they never verify.
      const isolated = env.HERMES_NATIVE_TOOLS_ISOLATED === 'true';
      const egress = env.QEYNOX_NETWORK_POLICY_ATTESTED === 'true';
      if (!isolated) missing.push('HERMES_NATIVE_TOOLS_ISOLATED=true');
      if (!egress) missing.push('QEYNOX_NETWORK_POLICY_ATTESTED=true');
      const target = origin && apiKey
        ? { endpoint: origin, fingerprint: digest(['hermes', origin, privateOrigin ?? '', provider, model, String(timeoutMs), createHash('sha256').update(apiKey).digest('hex')]) }
        : null;
      return { missing, attested: isolated && egress, target };
    },
    async probe(signal) {
      const { baseUrl, apiKey, privateOrigin, model } = read();
      const report = await probeHermes({ baseUrl, apiKey, privateOrigin, model, timeoutMs: 15_000, signal });
      if (!report.reachable) return { ok: false, failure: 'UNREACHABLE', detail: report.failures[0] ?? 'Hermes did not answer /health' };
      if (report.platform !== 'hermes-agent') return { ok: false, failure: 'IDENTITY_MISMATCH', detail: 'the endpoint does not identify itself as hermes-agent' };
      if (report.failures.some(failure => failure.startsWith('health endpoint'))) return { ok: false, failure: 'UNHEALTHY', detail: 'Hermes /health did not report status "ok"' };
      if (!report.runtimeVersion) return { ok: false, failure: 'IDENTITY_MISMATCH', detail: 'Hermes /health reported no version' };
      if (report.authRejected) return { ok: false, failure: 'AUTH_REJECTED', detail: 'Hermes rejected the API key' };
      if (!report.authenticated) return { ok: false, failure: signal.aborted ? 'TIMEOUT' : 'UNREACHABLE', detail: 'the authenticated model inventory could not be read' };
      if (report.nativeToolsIsolated !== true) {
        return { ok: false, failure: 'ISOLATION_NOT_EVIDENCED', detail: report.nativeToolsIsolated === null ? 'the toolset inventory could not be read' : 'the API server still exposes an enabled toolset' };
      }
      if (report.activeModelAdvertised !== true) return { ok: false, failure: 'MODEL_NOT_ADVERTISED', detail: 'the configured model is not advertised by /v1/models' };
      return { ok: true, identity: { endpoint: report.endpointOrigin ?? 'unknown', deployment: report.platform, version: report.runtimeVersion } };
    },
    secrets() {
      return [read().apiKey];
    },
  };
}

/** Hatchet: API ready, version reported, token accepted for its own tenant, engine gRPC reachable. */
export function hatchetProbeDefinition(env: NodeJS.ProcessEnv = process.env): RuntimeProbeDefinition {
  const read = () => {
    const token = (env.HATCHET_CLIENT_TOKEN ?? '').trim();
    return { token, resolution: resolveHatchetEndpoints({ token, apiUrl: env.HATCHET_CLIENT_API_URL, hostPort: env.HATCHET_CLIENT_HOST_PORT }) };
  };
  return {
    component: 'hatchet',
    configuration() {
      const { token, resolution } = read();
      if (!resolution.ok) return { missing: resolution.missing, attested: false, target: null };
      const e = resolution.endpoints;
      return {
        missing: [],
        attested: true,
        target: { endpoint: e.apiOrigin, fingerprint: digest(['hatchet', e.apiOrigin, e.grpcHost + ':' + e.grpcPort, e.tenantId, createHash('sha256').update(token).digest('hex')]) },
      };
    },
    async probe(signal) {
      const { token, resolution } = read();
      if (!resolution.ok) return { ok: false, failure: 'PROBE_ERROR', detail: 'Hatchet is not configured' };
      const report = await probeHatchet(resolution.endpoints, token, signal);
      if (!report.ok) return { ok: false, failure: report.failure, detail: report.detail };
      return {
        ok: true,
        identity: {
          endpoint: resolution.endpoints.apiOrigin,
          deployment: 'tenant ' + report.tenantId + (report.tenantSlug ? ' (' + report.tenantSlug + ')' : ''),
          version: report.version,
        },
      };
    },
    secrets() {
      return [read().token];
    },
  };
}

/** The production monitor: Hermes + Hatchet probes reading the given environment. */
export function createRuntimeProbeMonitor(env: NodeJS.ProcessEnv = process.env, options: RuntimeProbeMonitorOptions & { policy?: RuntimeProbePolicy } = {}): RuntimeProbeMonitor {
  return new RuntimeProbeMonitor([hermesProbeDefinition(env), hatchetProbeDefinition(env)], options.policy ?? runtimeProbePolicyFromEnv(env), options);
}

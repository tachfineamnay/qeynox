/**
 * Deployment runtime prerequisites for executing a mission step.
 *
 * The values are reported by the process that owns the configuration (API deployment env) and are
 * never inferred: an absent value is reported as missing, never as available.
 *
 * MISSION A01 — RUNTIME READINESS (four states):
 * - CONFIGURED: operator configuration records exist but the runtime has not been evaluated.
 * - OPERATIONAL: all prerequisites present AND the runtime component verified live. Only OPERATIONAL
 *   may be presented as executable.
 * - BLOCKED: a hard prerequisite is missing, an attestation is absent, or the latest probe FAILED.
 * - UNVERIFIED: configuration present, but there is no valid live evidence (never probed, evidence
 *   expired, or evidence gathered against a different endpoint/credential).
 *
 * MISSION A21.07 — TRUTHFUL RUNTIME READINESS:
 * - Live verification is evidence produced by a bounded probe of the real deployment
 *   (`runtime-probes.ts`), never an operator-set boolean and never a default string. The former
 *   `QEYNOX_RUNTIME_VERIFIED_LIVE` / `QEYNOX_RUNTIME_VERIFICATION_EVIDENCE` switches are ignored.
 * - Hermes (engine) and Hatchet (orchestrator) are verified separately: each has its own evidence
 *   reference, verified identity, probe timestamp, outcome and expiry, and one failing never alters the
 *   other's evidence.
 * - Evidence is bound to the configuration it was gathered with (endpoint + credential digest) and to a
 *   freshness limit. Changed configuration or expired evidence is UNVERIFIED, never OPERATIONAL.
 */
export type OperationalState = 'CONFIGURED' | 'OPERATIONAL' | 'BLOCKED' | 'UNVERIFIED';

export type RuntimeComponentId = 'hermes' | 'hatchet';

/**
 * Verification of one component against its latest probe evidence.
 * - NOT_CONFIGURED: a prerequisite is missing; nothing can be probed.
 * - NOT_PROBED: configured, but this process holds no evidence (e.g. just started).
 * - VERIFIED: the latest probe of the currently configured target succeeded and is still fresh.
 * - FAILED: the latest probe of the currently configured target failed (unavailable right now).
 * - STALE: the latest evidence is older than the freshness limit.
 * - TARGET_CHANGED: the evidence was gathered against a different endpoint or credential.
 */
export type RuntimeVerificationStatus = 'NOT_CONFIGURED' | 'NOT_PROBED' | 'VERIFIED' | 'FAILED' | 'STALE' | 'TARGET_CHANGED';

export type RuntimeProbeFailure =
  | 'TIMEOUT'
  | 'UNREACHABLE'
  | 'UNHEALTHY'
  | 'AUTH_REJECTED'
  | 'IDENTITY_MISMATCH'
  | 'ISOLATION_NOT_EVIDENCED'
  | 'MODEL_NOT_ADVERTISED'
  | 'INVALID_RESPONSE'
  | 'PROBE_ERROR';

/** What the deployment itself proved about who it is. Contains no credential. */
export interface RuntimeIdentity {
  /** Origin that answered the probe (scheme + host + port, no path, no credentials). */
  readonly endpoint: string;
  /** Deployment identity reported by the runtime (e.g. `hermes-agent`, `tenant <uuid>`). */
  readonly deployment: string;
  /** Version reported by the runtime itself; never guessed. */
  readonly version: string;
}

/** One probe result, as recorded by the process that ran the probe. */
export interface RuntimeProbeEvidence {
  readonly component: RuntimeComponentId;
  /** Unique reference of this probe run (`probe:<component>:<uuid>`). */
  readonly evidenceRef: string;
  /**
   * Digest of the configuration the probe ran against (endpoint + credential digest). Used only to
   * detect configuration changes; never serialized into API responses.
   */
  readonly targetFingerprint: string;
  /** Configured endpoint origin that was probed. */
  readonly endpoint: string;
  readonly outcome: 'SUCCEEDED' | 'FAILED';
  readonly failure: RuntimeProbeFailure | null;
  /** Redacted, bounded explanation of a failure. Never a credential and never remote free text. */
  readonly detail: string | null;
  /** Present only when the probe SUCCEEDED. */
  readonly identity: RuntimeIdentity | null;
  readonly startedAt: string;
  readonly observedAt: string;
  /** observedAt + freshness limit. At or after this instant the evidence proves nothing. */
  readonly expiresAt: string;
  readonly durationMs: number;
}

/** Verification view of one component (operator-grade detail; contains no credential). */
export interface RuntimeVerification {
  readonly status: RuntimeVerificationStatus;
  /** Reference of the evidence this status was derived from, or null when there is none. */
  readonly evidenceRef: string | null;
  /** Endpoint origin the evidence was gathered against. */
  readonly endpoint: string | null;
  /** Verified identity; present only when status is VERIFIED. */
  readonly identity: RuntimeIdentity | null;
  readonly outcome: 'SUCCEEDED' | 'FAILED' | null;
  readonly failure: RuntimeProbeFailure | null;
  readonly detail: string | null;
  readonly observedAt: string | null;
  readonly expiresAt: string | null;
}

export interface RuntimeComponent {
  readonly id: string;
  readonly configured: boolean;
  readonly missing: readonly string[];
  /** Four-state operational readiness for this component. */
  readonly state: OperationalState;
  /** True only when `verification.status` is VERIFIED (fresh, successful probe of the current target). */
  readonly verifiedLive: boolean;
  /** True when required operator attestations are present. An attestation alone never verifies. */
  readonly attested: boolean;
  /** Evidence reference of the VERIFIED probe; null otherwise. Never a default or synthetic value. */
  readonly evidence: string | null;
  /** MISSION A21.07: the component's own verification record. */
  readonly verification: RuntimeVerification;
}

export interface RuntimeReadiness {
  readonly engine: RuntimeComponent;
  readonly orchestrator: RuntimeComponent;
  /** Overall runtime state: OPERATIONAL only when both components are OPERATIONAL. */
  readonly overallState: OperationalState;
  /** True only when overallState is OPERATIONAL and both components are verified live. */
  readonly canExecute: boolean;
}

export type RuntimeReadinessSource = () => RuntimeReadiness;

/**
 * Compute operational state from component readiness.
 * BLOCKED if any hard missing, UNVERIFIED if configured but not verifiedLive,
 * OPERATIONAL only if all configured + verifiedLive + attested.
 */
export function computeOperationalState(
  configured: boolean,
  verifiedLive: boolean,
  attested: boolean,
  missingCount: number,
): OperationalState {
  if (!configured || missingCount > 0) return 'BLOCKED';
  if (!attested) return 'BLOCKED';
  if (!verifiedLive) return 'UNVERIFIED';
  return 'OPERATIONAL';
}

const NO_VERIFICATION = (status: RuntimeVerificationStatus): RuntimeVerification => ({
  status, evidenceRef: null, endpoint: null, identity: null, outcome: null, failure: null, detail: null, observedAt: null, expiresAt: null,
});

/** Tolerated forward clock skew for evidence timestamps (evidence from the future proves nothing). */
const MAX_FUTURE_SKEW_MS = 5_000;

/**
 * MISSION A21.07: decide one component's verification from its configuration and latest evidence.
 * Pure: the caller passes the clock. Every path that is not a fresh, successful probe of the
 * currently configured target is non-executable.
 */
export function evaluateRuntimeComponent(input: {
  readonly id: RuntimeComponentId;
  readonly missing: readonly string[];
  readonly attested: boolean;
  /** Fingerprint of the currently configured target; null when nothing can be probed. */
  readonly targetFingerprint: string | null;
  readonly evidence: RuntimeProbeEvidence | null;
  readonly now: Date;
}): RuntimeComponent {
  const configured = input.missing.length === 0 && input.targetFingerprint !== null;
  let verification: RuntimeVerification;
  const evidence = input.evidence && input.evidence.component === input.id ? input.evidence : null;
  if (!configured) {
    verification = NO_VERIFICATION('NOT_CONFIGURED');
  } else if (!evidence) {
    verification = NO_VERIFICATION('NOT_PROBED');
  } else {
    const base = {
      evidenceRef: evidence.evidenceRef, endpoint: evidence.endpoint, outcome: evidence.outcome,
      failure: evidence.failure, detail: evidence.detail, observedAt: evidence.observedAt, expiresAt: evidence.expiresAt,
    };
    const now = input.now.getTime();
    const observed = Date.parse(evidence.observedAt);
    const expires = Date.parse(evidence.expiresAt);
    if (evidence.targetFingerprint !== input.targetFingerprint) {
      verification = { status: 'TARGET_CHANGED', identity: null, ...base };
    } else if (!Number.isFinite(observed) || !Number.isFinite(expires) || now >= expires || observed > now + MAX_FUTURE_SKEW_MS) {
      verification = { status: 'STALE', identity: null, ...base };
    } else if (evidence.outcome === 'FAILED') {
      verification = { status: 'FAILED', identity: null, ...base };
    } else if (evidence.identity && evidence.evidenceRef) {
      verification = { status: 'VERIFIED', identity: evidence.identity, ...base };
    } else {
      // A "success" without a proven identity is not evidence.
      verification = { status: 'NOT_PROBED', identity: null, ...base };
    }
  }
  const verifiedLive = verification.status === 'VERIFIED';
  const missing = input.missing.length || input.targetFingerprint !== null ? input.missing : ['runtime endpoint'];
  const state: OperationalState = verification.status === 'FAILED' && input.attested
    ? 'BLOCKED'
    : computeOperationalState(configured, verifiedLive, input.attested, missing.length);
  return {
    id: input.id,
    configured,
    missing,
    state,
    verifiedLive,
    attested: input.attested,
    evidence: verifiedLive ? verification.evidenceRef : null,
    verification,
  };
}

/** Combine both components. Execution needs BOTH verified; neither can stand in for the other. */
export function combineRuntimeReadiness(engine: RuntimeComponent, orchestrator: RuntimeComponent): RuntimeReadiness {
  const overallState: OperationalState =
    engine.state === 'BLOCKED' || orchestrator.state === 'BLOCKED'
      ? 'BLOCKED'
      : engine.state === 'UNVERIFIED' || orchestrator.state === 'UNVERIFIED'
        ? 'UNVERIFIED'
        : engine.state === 'OPERATIONAL' && orchestrator.state === 'OPERATIONAL'
          ? 'OPERATIONAL'
          : 'CONFIGURED';
  return {
    engine,
    orchestrator,
    overallState,
    canExecute: overallState === 'OPERATIONAL' && engine.verifiedLive && orchestrator.verifiedLive,
  };
}

const COMPONENT_LABEL: Record<string, string> = { hermes: 'Hermes agent runtime', hatchet: 'Hatchet workflow executor' };

function describeComponent(component: RuntimeComponent): string {
  const label = COMPONENT_LABEL[component.id] ?? component.id;
  const v = component.verification;
  switch (v.status) {
    case 'NOT_CONFIGURED': return label + ' is not configured (missing: ' + component.missing.join(', ') + ')';
    case 'NOT_PROBED': return label + ' has not been verified by a live probe yet';
    case 'STALE': return label + ' verification expired at ' + v.expiresAt;
    case 'TARGET_CHANGED': return label + ' configuration changed since the last probe; it must be verified again';
    case 'FAILED': return label + ' is unavailable: the probe at ' + v.observedAt + ' failed (' + v.failure + ')';
    case 'VERIFIED': return component.attested ? label + ' is verified' : label + ' attestations are missing (' + component.missing.join(', ') + ')';
  }
}

/**
 * MISSION A21.07: the single launch gate shared by the API and the worker. Returns null only when
 * both components are verified live; otherwise the error code and an operator-safe message.
 * A FAILED probe is UNAVAILABLE; anything else not proven is NOT_CONFIGURED.
 */
export function runtimeExecutionBlocker(readiness: RuntimeReadiness): { readonly code: 'NOT_CONFIGURED' | 'UNAVAILABLE'; readonly message: string } | null {
  if (readiness.canExecute) return null;
  const blocking = [readiness.engine, readiness.orchestrator].filter(component => !(component.verifiedLive && component.state === 'OPERATIONAL'));
  const unavailable = blocking.some(component => component.verification.status === 'FAILED');
  const parts = blocking.length ? blocking.map(describeComponent) : ['runtime readiness is ' + readiness.overallState];
  return { code: unavailable ? 'UNAVAILABLE' : 'NOT_CONFIGURED', message: 'Mission runtime is not operational: ' + parts.join('; ') };
}

/** Customer-safe summary of one component (no endpoint, no identity, no evidence reference). */
export interface RuntimeComponentSummary {
  readonly status: RuntimeVerificationStatus;
  readonly failure: RuntimeProbeFailure | null;
  readonly checkedAt: string | null;
  readonly expiresAt: string | null;
}

export function summarizeRuntimeComponent(component: RuntimeComponent): RuntimeComponentSummary {
  const v = component.verification;
  return { status: v.status, failure: v.status === 'FAILED' ? v.failure : null, checkedAt: v.observedAt, expiresAt: v.expiresAt };
}

/** Fail closed when no deployment source is wired: nothing is assumed configured. */
export const failClosedRuntime: RuntimeReadinessSource = () => {
  const engineMissing = ['HERMES_API_BASE_URL', 'HERMES_API_KEY', 'HERMES_NATIVE_TOOLS_ISOLATED=true', 'QEYNOX_NETWORK_POLICY_ATTESTED=true'];
  const orchestratorMissing = ['HATCHET_CLIENT_TOKEN'];
  return {
    engine: {
      id: 'hermes', configured: false, missing: engineMissing, state: 'BLOCKED',
      verifiedLive: false, attested: false, evidence: null, verification: NO_VERIFICATION('NOT_CONFIGURED'),
    },
    orchestrator: {
      id: 'hatchet', configured: false, missing: orchestratorMissing, state: 'BLOCKED',
      verifiedLive: false, attested: false, evidence: null, verification: NO_VERIFICATION('NOT_CONFIGURED'),
    },
    overallState: 'BLOCKED',
    canExecute: false,
  };
};

/**
 * QA builder (test infrastructure only): a RuntimeReadiness with explicit verification.
 * A component is VERIFIED only when `verifiedLive` is true AND an evidence reference is given; a
 * QA-contract success without evidence stays unverified. `*Failure` builds a FAILED probe.
 */
export function makeRuntimeReadiness(options: {
  engineConfigured?: boolean;
  engineMissing?: readonly string[];
  engineVerifiedLive?: boolean;
  engineAttested?: boolean;
  engineEvidence?: string | null;
  engineFailure?: RuntimeProbeFailure;
  orchestratorConfigured?: boolean;
  orchestratorMissing?: readonly string[];
  orchestratorVerifiedLive?: boolean;
  orchestratorAttested?: boolean;
  orchestratorEvidence?: string | null;
  orchestratorFailure?: RuntimeProbeFailure;
}): RuntimeReadiness {
  const build = (id: RuntimeComponentId, defaultMissing: string, configuredOpt?: boolean, missingOpt?: readonly string[], verifiedOpt?: boolean, attestedOpt?: boolean, evidenceOpt?: string | null, failure?: RuntimeProbeFailure): RuntimeComponent => {
    const missing = missingOpt ?? (configuredOpt === false ? [defaultMissing] : []);
    const configured = (configuredOpt ?? missing.length === 0) && missing.length === 0;
    const attested = attestedOpt ?? configured;
    const evidenceRef = evidenceOpt ?? null;
    const verified = configured && verifiedOpt === true && Boolean(evidenceRef) && !failure;
    const observedAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 120_000).toISOString();
    const verification: RuntimeVerification = !configured
      ? NO_VERIFICATION('NOT_CONFIGURED')
      : failure
        ? { status: 'FAILED', evidenceRef: evidenceRef ?? 'qa-fixture:' + id + ':failed', endpoint: 'qa-fixture', identity: null, outcome: 'FAILED', failure, detail: 'QA fixture failure', observedAt, expiresAt }
        : verified
          ? { status: 'VERIFIED', evidenceRef, endpoint: 'qa-fixture', identity: { endpoint: 'qa-fixture', deployment: 'qa-fixture', version: 'qa-fixture' }, outcome: 'SUCCEEDED', failure: null, detail: null, observedAt, expiresAt }
          : NO_VERIFICATION('NOT_PROBED');
    const state: OperationalState = verification.status === 'FAILED' && attested ? 'BLOCKED' : computeOperationalState(configured, verified, attested, missing.length);
    return { id, configured, missing, state, verifiedLive: verified, attested, evidence: verified ? evidenceRef : null, verification };
  };
  return combineRuntimeReadiness(
    build('hermes', 'HERMES_API_BASE_URL', options.engineConfigured, options.engineMissing, options.engineVerifiedLive, options.engineAttested, options.engineEvidence, options.engineFailure),
    build('hatchet', 'HATCHET_CLIENT_TOKEN', options.orchestratorConfigured, options.orchestratorMissing, options.orchestratorVerifiedLive, options.orchestratorAttested, options.orchestratorEvidence, options.orchestratorFailure),
  );
}

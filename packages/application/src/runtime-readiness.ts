/**
 * Deployment runtime prerequisites for executing a mission step.
 *
 * The values are reported by the process that owns the configuration (API deployment env) and are
 * never inferred: an absent value is reported as missing, never as available.
 *
 * MISSION A01 — RUNTIME READINESS:
 * - CONFIGURED: operator configuration records exist (capability, profile, provider, policy,
 *   budget) but live runtime has not been verified. Never executable.
 * - OPERATIONAL: all prerequisites present AND runtime verified live (engine invocation verified,
 *   attestations present, orchestrator configured, budget not exhausted, execution authorized).
 *   Only OPERATIONAL may be presented as executable.
 * - BLOCKED: one or more hard prerequisites missing. Never executable.
 * - UNVERIFIED: configuration present but runtime code is UNVERIFIED (e.g. Hermes
 *   runtimeVersion UNVERIFIED, isolation NOT_VERIFIED) or live probe absent. Never executable.
 *
 * A configuration flag alone is never proof of live functionality. QA contract success
 * (Hermes adapter parses wire response in isolated fixture) is distinct from operational
 * readiness (live endpoint reachable, attestations present, verifiedLive evidence recorded).
 */
export type OperationalState = 'CONFIGURED' | 'OPERATIONAL' | 'BLOCKED' | 'UNVERIFIED';

export interface RuntimeComponent {
  readonly id: string;
  readonly configured: boolean;
  readonly missing: readonly string[];
  /** Four-state operational readiness for this component. */
  readonly state: OperationalState;
  /** True only when live invocation has been verified with evidence (not just env present). */
  readonly verifiedLive: boolean;
  /** True when required attestations are present (engine: isolation + egress; orchestrator: token). */
  readonly attested: boolean;
  /** Evidence reference for live verification (e.g. probe timestamp, run ID). Null when unverified. */
  readonly evidence: string | null;
}

export interface RuntimeReadiness {
  readonly engine: RuntimeComponent;
  readonly orchestrator: RuntimeComponent;
  /** Overall runtime state: OPERATIONAL only when both components are OPERATIONAL. */
  readonly overallState: OperationalState;
  /** True only when overallState is OPERATIONAL. */
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

/** Fail closed when no deployment source is wired: nothing is assumed configured. */
export const failClosedRuntime: RuntimeReadinessSource = () => {
  const engineMissing = ['HERMES_API_BASE_URL', 'HERMES_API_KEY', 'HERMES_NATIVE_TOOLS_ISOLATED=true', 'QEYNOX_NETWORK_POLICY_ATTESTED=true'];
  const orchestratorMissing = ['HATCHET_CLIENT_TOKEN'];
  return {
    engine: {
      id: 'hermes',
      configured: false,
      missing: engineMissing,
      state: 'BLOCKED',
      verifiedLive: false,
      attested: false,
      evidence: null,
    },
    orchestrator: {
      id: 'hatchet',
      configured: false,
      missing: orchestratorMissing,
      state: 'BLOCKED',
      verifiedLive: false,
      attested: false,
      evidence: null,
    },
    overallState: 'BLOCKED',
    canExecute: false,
  };
};

/**
 * Helper for tests and QA: build a RuntimeReadiness with explicit verification.
 * QA contract success is NOT operational readiness unless verifiedLive=true with evidence.
 */
export function makeRuntimeReadiness(options: {
  engineConfigured?: boolean;
  engineMissing?: readonly string[];
  engineVerifiedLive?: boolean;
  engineAttested?: boolean;
  engineEvidence?: string | null;
  orchestratorConfigured?: boolean;
  orchestratorMissing?: readonly string[];
  orchestratorVerifiedLive?: boolean;
  orchestratorAttested?: boolean;
  orchestratorEvidence?: string | null;
}): RuntimeReadiness {
  const engineMissing = options.engineMissing ?? (options.engineConfigured === false ? ['HERMES_API_BASE_URL'] : []);
  const engineConfigured = options.engineConfigured ?? (engineMissing.length === 0);
  const engineVerifiedLive = options.engineVerifiedLive ?? false;
  const engineAttested = options.engineAttested ?? engineConfigured;
  const engineState = computeOperationalState(engineConfigured, engineVerifiedLive, engineAttested, engineMissing.length);

  const orchestratorMissing = options.orchestratorMissing ?? (options.orchestratorConfigured === false ? ['HATCHET_CLIENT_TOKEN'] : []);
  const orchestratorConfigured = options.orchestratorConfigured ?? (orchestratorMissing.length === 0);
  const orchestratorVerifiedLive = options.orchestratorVerifiedLive ?? false;
  const orchestratorAttested = options.orchestratorAttested ?? orchestratorConfigured;
  const orchestratorState = computeOperationalState(orchestratorConfigured, orchestratorVerifiedLive, orchestratorAttested, orchestratorMissing.length);

  const overallState: OperationalState =
    engineState === 'BLOCKED' || orchestratorState === 'BLOCKED'
      ? 'BLOCKED'
      : engineState === 'UNVERIFIED' || orchestratorState === 'UNVERIFIED'
        ? 'UNVERIFIED'
        : engineState === 'OPERATIONAL' && orchestratorState === 'OPERATIONAL'
          ? 'OPERATIONAL'
          : 'CONFIGURED';

  return {
    engine: {
      id: 'hermes',
      configured: engineConfigured,
      missing: engineMissing,
      state: engineState,
      verifiedLive: engineVerifiedLive,
      attested: engineAttested,
      evidence: options.engineEvidence ?? null,
    },
    orchestrator: {
      id: 'hatchet',
      configured: orchestratorConfigured,
      missing: orchestratorMissing,
      state: orchestratorState,
      verifiedLive: orchestratorVerifiedLive,
      attested: orchestratorAttested,
      evidence: options.orchestratorEvidence ?? null,
    },
    overallState,
    canExecute: overallState === 'OPERATIONAL',
  };
}

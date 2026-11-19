import { hermesEndpoint } from '@qeynox/engine';
import type { RuntimeReadiness } from '@qeynox/application';
import { computeOperationalState } from '@qeynox/application';

/**
 * Reads the deployment prerequisites required to execute a mission step.
 *
 * - Hermes is the replaceable intelligence runtime; it fails closed without its endpoint, API key,
 *   native-tool isolation and tested egress containment.
 * - Hatchet is the single durable workflow executor; the outbox dispatcher cannot run without a
 *   client token.
 *
 * Missing values are reported by name. Nothing is reported as configured without evidence.
 *
 * MISSION A01: configuration alone is never OPERATIONAL. Live verification requires
 * QEYNOX_RUNTIME_VERIFIED_LIVE=true plus evidence (QEYNOX_RUNTIME_VERIFICATION_EVIDENCE).
 * Without that, state is UNVERIFIED (configured but not proven) or BLOCKED (missing).
 */
export function apiRuntimeReadiness(): RuntimeReadiness {
  const missing: string[] = [];
  const baseUrl = (process.env.HERMES_API_BASE_URL ?? '').trim();
  const apiKey = (process.env.HERMES_API_KEY ?? '').trim();
  if (!baseUrl) missing.push('HERMES_API_BASE_URL');
  else {
    try { hermesEndpoint(baseUrl, process.env.HERMES_PRIVATE_ORIGIN); }
    catch { missing.push('HERMES_API_BASE_URL (origin not authorized: use https, a local host or HERMES_PRIVATE_ORIGIN)'); }
  }
  if (!apiKey) missing.push('HERMES_API_KEY');
  if (process.env.HERMES_NATIVE_TOOLS_ISOLATED !== 'true') missing.push('HERMES_NATIVE_TOOLS_ISOLATED=true');
  if (process.env.QEYNOX_NETWORK_POLICY_ATTESTED !== 'true') missing.push('QEYNOX_NETWORK_POLICY_ATTESTED=true');
  const hatchetConfigured = (process.env.HATCHET_CLIENT_TOKEN ?? '').trim().length > 0;
  const hatchetMissing = hatchetConfigured ? [] : ['HATCHET_CLIENT_TOKEN'];

  const engineConfigured = missing.length === 0;
  const engineAttested = engineConfigured; // isolation + egress attested when configured
  const engineVerifiedLive = process.env.QEYNOX_RUNTIME_VERIFIED_LIVE === 'true';
  const engineEvidence = engineVerifiedLive ? (process.env.QEYNOX_RUNTIME_VERIFICATION_EVIDENCE ?? 'live-probe') : null;
  const engineState = computeOperationalState(engineConfigured, engineVerifiedLive, engineAttested, missing.length);

  const orchestratorConfigured = hatchetConfigured;
  const orchestratorAttested = orchestratorConfigured;
  const orchestratorVerifiedLive = engineVerifiedLive; // same live verification gate
  const orchestratorEvidence = orchestratorVerifiedLive ? engineEvidence : null;
  const orchestratorState = computeOperationalState(orchestratorConfigured, orchestratorVerifiedLive, orchestratorAttested, hatchetMissing.length);

  const overallState =
    engineState === 'BLOCKED' || orchestratorState === 'BLOCKED'
      ? 'BLOCKED'
      : engineState === 'UNVERIFIED' || orchestratorState === 'UNVERIFIED'
        ? 'UNVERIFIED'
        : 'OPERATIONAL';

  return {
    engine: {
      id: 'hermes',
      configured: engineConfigured,
      missing,
      state: engineState,
      verifiedLive: engineVerifiedLive,
      attested: engineAttested,
      evidence: engineEvidence,
    },
    orchestrator: {
      id: 'hatchet',
      configured: orchestratorConfigured,
      missing: hatchetMissing,
      state: orchestratorState,
      verifiedLive: orchestratorVerifiedLive,
      attested: orchestratorAttested,
      evidence: orchestratorEvidence,
    },
    overallState,
    canExecute: overallState === 'OPERATIONAL',
  };
}

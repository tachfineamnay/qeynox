/**
 * MISSION A01 — Negative regression tests for runtime readiness.
 * Verifies fail-closed behavior: UNVERIFIED runtime, missing attestations, missing policy,
 * missing budget, missing execution authorization all block OPERATIONAL.
 */
import assert from 'node:assert/strict';
import { makeRuntimeReadiness, failClosedRuntime, runtimeExecutionBlocker } from '../src/runtime-readiness';
import { computeCapabilityOperationalState } from '../src/capability-availability';

let assertions = 0;
function check(condition: unknown, message: string): asserts condition {
  assertions++;
  if (!condition) throw new Error('ASSERTION FAILED: ' + message);
}
function eq<T>(actual: T, expected: T, message: string) {
  assertions++;
  if (actual !== expected) throw new Error(`ASSERTION FAILED: ${message} — expected ${String(expected)}, got ${String(actual)}`);
}

// Negative 1: Engine configured but not verifiedLive -> UNVERIFIED, never OPERATIONAL
const n1 = makeRuntimeReadiness({
  engineConfigured: true, engineMissing: [], engineVerifiedLive: false, engineAttested: true,
  orchestratorConfigured: true, orchestratorMissing: [], orchestratorVerifiedLive: false, orchestratorAttested: true,
});
eq(n1.overallState, 'UNVERIFIED', 'N1: configured but not verifiedLive is UNVERIFIED');
eq(n1.canExecute, false, 'N1: UNVERIFIED canExecute false');

// Negative 2: Missing attestation -> BLOCKED
const n2 = makeRuntimeReadiness({
  engineConfigured: true, engineMissing: [], engineVerifiedLive: true, engineAttested: false,
  orchestratorConfigured: true, orchestratorMissing: [], orchestratorVerifiedLive: true, orchestratorAttested: true,
});
eq(n2.overallState, 'BLOCKED', 'N2: missing attestation is BLOCKED');
eq(n2.engine.state, 'BLOCKED', 'N2: engine BLOCKED when not attested');

// Negative 3: Missing engine env -> BLOCKED
const n3 = makeRuntimeReadiness({
  engineConfigured: false, engineMissing: ['HERMES_API_BASE_URL', 'HERMES_API_KEY'],
  orchestratorConfigured: true, orchestratorMissing: [], orchestratorVerifiedLive: true, orchestratorAttested: true,
});
eq(n3.overallState, 'BLOCKED', 'N3: missing engine env is BLOCKED');

// Negative 4: Missing orchestrator -> BLOCKED
const n4 = makeRuntimeReadiness({
  engineConfigured: true, engineMissing: [], engineVerifiedLive: true, engineAttested: true,
  orchestratorConfigured: false, orchestratorMissing: ['HATCHET_CLIENT_TOKEN'],
});
eq(n4.overallState, 'BLOCKED', 'N4: missing orchestrator is BLOCKED');

// Negative 5: Capability missing policy -> BLOCKED even with OPERATIONAL runtime
const operational = makeRuntimeReadiness({
  engineConfigured: true, engineMissing: [], engineVerifiedLive: true, engineAttested: true, engineEvidence: 'probe',
  orchestratorConfigured: true, orchestratorMissing: [], orchestratorVerifiedLive: true, orchestratorAttested: true, orchestratorEvidence: 'probe',
});
eq(computeCapabilityOperationalState({ providerReady: true, profileReady: true, policyReady: false, runtime: operational }), 'BLOCKED', 'N5: missing policy blocks capability');

// Negative 6: Capability missing profile -> BLOCKED
eq(computeCapabilityOperationalState({ providerReady: true, profileReady: false, policyReady: true, runtime: operational }), 'BLOCKED', 'N6: missing profile blocks');

// Negative 7: Capability missing provider -> BLOCKED
eq(computeCapabilityOperationalState({ providerReady: false, profileReady: true, policyReady: true, runtime: operational }), 'BLOCKED', 'N7: missing provider blocks');

// Negative 8: failClosedRuntime is BLOCKED, never OPERATIONAL
const closed = failClosedRuntime();
eq(closed.overallState, 'BLOCKED', 'N8: failClosed is BLOCKED');
eq(closed.canExecute, false, 'N8: failClosed canExecute false');
check(closed.engine.missing.length >= 2, 'N8: failClosed lists missing env');

// Negative 9: Config flag alone (configured=true, verifiedLive=false) is not OPERATIONAL
const configOnly = makeRuntimeReadiness({
  engineConfigured: true, engineMissing: [], engineVerifiedLive: false, engineAttested: true,
  orchestratorConfigured: true, orchestratorMissing: [], orchestratorVerifiedLive: false, orchestratorAttested: true,
});
check(configOnly.overallState !== 'OPERATIONAL', 'N9: config flag alone is not OPERATIONAL');
eq(configOnly.overallState, 'UNVERIFIED', 'N9: config only is UNVERIFIED');

// Negative 10: QA contract success vs operational readiness
// Hermes adapter parsing wire response in fixture does not imply verifiedLive.
// makeRuntimeReadiness with verifiedLive=false simulates QA contract success.
const qa = makeRuntimeReadiness({
  engineConfigured: true, engineMissing: [], engineVerifiedLive: false, engineAttested: true, engineEvidence: null,
  orchestratorConfigured: true, orchestratorMissing: [], orchestratorVerifiedLive: false, orchestratorAttested: true,
});
eq(qa.overallState, 'UNVERIFIED', 'N10: QA contract success is UNVERIFIED');
check(qa.canExecute === false, 'N10: QA contract success is not canExecute');

// Positive: OPERATIONAL requires all
const pos = makeRuntimeReadiness({
  engineConfigured: true, engineMissing: [], engineVerifiedLive: true, engineAttested: true, engineEvidence: 'qa-fixture:runtime-readiness-negative',
  orchestratorConfigured: true, orchestratorMissing: [], orchestratorVerifiedLive: true, orchestratorAttested: true, orchestratorEvidence: 'qa-fixture:runtime-readiness-negative',
});
eq(pos.overallState, 'OPERATIONAL', 'P1: all prerequisites + verifiedLive + attested -> OPERATIONAL');
eq(pos.canExecute, true, 'P1: OPERATIONAL canExecute true');
eq(computeCapabilityOperationalState({ providerReady: true, profileReady: true, policyReady: true, runtime: pos }), 'OPERATIONAL', 'P1: capability OPERATIONAL');

// A21.07 negatives: an operator boolean never verifies; a failed probe is BLOCKED and UNAVAILABLE.
const flagOnly = makeRuntimeReadiness({ engineVerifiedLive: true, orchestratorVerifiedLive: true });
check(!flagOnly.canExecute && flagOnly.engine.verification.status === 'NOT_PROBED' && flagOnly.orchestrator.verification.status === 'NOT_PROBED', 'N11: verifiedLive=true without evidence -> NOT_PROBED, not executable');
const engineFailed = makeRuntimeReadiness({ engineFailure: 'TIMEOUT', orchestratorVerifiedLive: true, orchestratorEvidence: 'qa-fixture:runtime-readiness-negative' });
eq(engineFailed.engine.state, 'BLOCKED', 'N12: failed Hermes probe -> Hermes BLOCKED');
eq(engineFailed.orchestrator.state, 'OPERATIONAL', 'N12: Hatchet unaffected by the Hermes failure');
check(!engineFailed.canExecute, 'N12: one failed component blocks execution');
eq(runtimeExecutionBlocker(engineFailed)?.code, 'UNAVAILABLE', 'N12: failed probe -> UNAVAILABLE');
const orchestratorFailed = makeRuntimeReadiness({ engineVerifiedLive: true, engineEvidence: 'qa-fixture:runtime-readiness-negative', orchestratorFailure: 'AUTH_REJECTED' });
check(!orchestratorFailed.canExecute && orchestratorFailed.orchestrator.verification.failure === 'AUTH_REJECTED', 'N13: failed Hatchet probe blocks execution with its own failure');
check(failClosedRuntime().engine.verification.status === 'NOT_CONFIGURED' && failClosedRuntime().engine.evidence === null, 'N14: fail-closed runtime carries no evidence');
eq(runtimeExecutionBlocker(failClosedRuntime())?.code, 'NOT_CONFIGURED', 'N14: fail-closed runtime -> NOT_CONFIGURED');

console.log(`Runtime readiness NEGATIVE QA PASSED: ${assertions} assertions`);

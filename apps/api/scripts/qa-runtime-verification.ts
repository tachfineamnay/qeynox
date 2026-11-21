/**
 * MISSION A21.07 — truthful runtime readiness: real probes, real sockets, real PostgreSQL, real HTTP API.
 *
 * What is verified:
 *   1. Pure rules: the policy is clamped (a probe is always bounded, evidence always expires), the QA
 *      builder never verifies without evidence, the launch blocker codes and the customer summary shape.
 *   2. Monitor against local Hermes and Hatchet fixtures speaking their documented wire contracts:
 *      missing configuration, missing evidence (NOT_PROBED), Hermes-only success, Hatchet-only success,
 *      both verified, stale evidence (injected clock), timeout (250 ms bound, the other component
 *      unaffected), a process restart (new monitor: no evidence), a runtime restart (down → FAILED, back
 *      with a new version → VERIFIED with the new identity), configuration change (TARGET_CHANGED),
 *      every failure classification, in-flight probe sharing, freshReadiness and the ignored operator
 *      boolean `QEYNOX_RUNTIME_VERIFIED_LIVE`.
 *   3. Launch gate (OperationExecutionService) against the monitor: refused while either component is
 *      unproven, NOT_CONFIGURED vs UNAVAILABLE, and no beta allowance, attempt or outbox row consumed.
 *   4. HTTP: `/v1/operations/:id/readiness` (per-component blockers + verification summary),
 *      `POST /v1/operations/:id/start` (503/502 until both are verified, then 201), the beta journey
 *      runtime summaries, `/v1/platform/capabilities` operator evidence, and the boot lifecycle that
 *      starts background probing.
 *   5. No credential appears in any recorded evidence, readiness object or HTTP response, and probes
 *      send credentials only to the endpoints that need them.
 *
 * HONEST BOUNDARY: Hermes and Hatchet are deterministic local fixtures (QA infrastructure only) that
 * implement the documented endpoints; no real Hermes or Hatchet deployment is contacted, and no worker
 * runs here. Passing proves the probes, evaluation and gates; it does NOT prove any real deployment.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { eq, sql } from 'drizzle-orm';
import {
  QeyNoxStore, connectDatabase, runMigrations,
  betaGrants, identityCredentials, identityUsers, platformAdminAssignments,
} from '@qeynox/persistence';
import {
  CommerceService, ConfigurationService, OperationExecutionService, PlanningService, RuntimeProbeMonitor,
  createRuntimeProbeMonitor, makeRuntimeReadiness, runtimeExecutionBlocker, runtimeProbePolicyFromEnv, summarizeRuntimeComponent,
  type RuntimeProbePolicy, type RuntimeReadiness,
} from '@qeynox/application';
import { DomainError, type ID, type Principal } from '@qeynox/domain';
import { AppModule } from '../src/app.module';
import { DomainExceptionFilter } from '../src/transport/domain-exception.filter';
import { hashPassword } from '../src/auth/password';
import { apiRuntimeMonitor, restartApiRuntimeMonitor } from '../src/operations/runtime-readiness';
import { createIsolatedQaDatabase } from './qa-isolated-database';
import { seedQaBetaGrant } from './qa-beta-fixture';
import { HatchetFixture, HermesFixture, RUNTIME_ENV_KEYS, runtimeEnvironment } from './qa-runtime-fixtures';

let assertions = 0;
let groups = 0;
function assert(condition: unknown, message: string): asserts condition {
  assertions++;
  if (!condition) throw new Error('ASSERTION FAILED: ' + message);
}
function pass(message: string): void { groups++; console.log('PASS: ' + message); }

/** Everything recorded or returned, scanned for credentials at the end. */
const recorded: string[] = [];
function record<T>(value: T): T { recorded.push(JSON.stringify(value)); return value; }
/** Raw in-process evidence (carries the internal configuration digest by design); scanned for secrets only. */
const internalEvidence: string[] = [];

async function http(base: string, path: string, init: { json?: unknown; headers?: Record<string, string> } = {}) {
  const body = init.json === undefined ? undefined : JSON.stringify(init.json);
  const response = await fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(init.headers ?? {}) },
    ...(body === undefined ? {} : { body }),
  });
  const text = await response.text();
  recorded.push(text);
  let parsed: unknown = text;
  try { parsed = JSON.parse(text); } catch { /* plain text */ }
  return { status: response.status, body: parsed as Record<string, unknown> };
}

async function expectDomainError(code: string, run: () => Promise<unknown>, label: string): Promise<DomainError> {
  try {
    await run();
  } catch (error) {
    assert(error instanceof DomainError && error.code === code, label + ': expected DomainError ' + code + ', got ' + (error instanceof DomainError ? error.code : String(error)));
    return error;
  }
  throw new Error('ASSERTION FAILED: ' + label + ': expected DomainError ' + code + ', but it succeeded');
}

const QA_POLICY: RuntimeProbePolicy = { timeoutMs: 250, freshnessMs: 60_000, intervalMs: 30_000 };

function states(readiness: RuntimeReadiness): string {
  return 'hermes=' + readiness.engine.verification.status + '/' + readiness.engine.state + ' hatchet=' + readiness.orchestrator.verification.status + '/' + readiness.orchestrator.state + ' canExecute=' + String(readiness.canExecute);
}

async function main(): Promise<void> {
  if (!process.env.QEYNOX_QA_DATABASE_URL) {
    console.log('BLOCKED: QEYNOX_QA_DATABASE_URL is not set. The runtime-verification QA suite requires an isolated PostgreSQL database; no result is claimed.');
    process.exitCode = 1;
    return;
  }
  const startedAt = Date.now();
  const savedEnv = Object.fromEntries(RUNTIME_ENV_KEYS.map(key => [key, process.env[key]]));
  const hermes = new HermesFixture();
  const hatchet = new HatchetFixture();
  let connection: ReturnType<typeof connectDatabase> | undefined;
  let app: INestApplication | undefined;
  let qa: Awaited<ReturnType<typeof createIsolatedQaDatabase>> | undefined;
  const monitors: RuntimeProbeMonitor[] = [];
  try {
    await hermes.up();
    await hatchet.up();

    // ── Group 1 · pure rules ───────────────────────────────────────────────────────────────────
    const defaults = runtimeProbePolicyFromEnv({});
    assert(defaults.timeoutMs === 5000 && defaults.freshnessMs === 120_000 && defaults.intervalMs === 30_000, 'default policy: 5 s probe bound, 120 s freshness, 30 s interval');
    const tiny = runtimeProbePolicyFromEnv({ QEYNOX_RUNTIME_PROBE_TIMEOUT_MS: '1', QEYNOX_RUNTIME_PROBE_FRESHNESS_SECONDS: '0', QEYNOX_RUNTIME_PROBE_INTERVAL_SECONDS: '0' });
    assert(tiny.timeoutMs === 250 && tiny.freshnessMs === 10_000 && tiny.intervalMs === 5_000, 'policy lower clamps: 250 ms, 10 s, 5 s');
    const huge = runtimeProbePolicyFromEnv({ QEYNOX_RUNTIME_PROBE_TIMEOUT_MS: '999999', QEYNOX_RUNTIME_PROBE_FRESHNESS_SECONDS: '999999', QEYNOX_RUNTIME_PROBE_INTERVAL_SECONDS: '999999' });
    assert(huge.timeoutMs === 15_000 && huge.freshnessMs === 900_000 && huge.intervalMs === 450_000, 'policy upper clamps: a probe is bounded at 15 s and evidence lives at most 900 s; interval ≤ freshness/2');
    const junk = runtimeProbePolicyFromEnv({ QEYNOX_RUNTIME_PROBE_TIMEOUT_MS: 'forever', QEYNOX_RUNTIME_PROBE_FRESHNESS_SECONDS: 'Infinity' });
    assert(junk.timeoutMs === 5000 && junk.freshnessMs === 120_000, 'non-numeric policy values fall back to the defaults (never unbounded)');
    assert((() => { try { new RuntimeProbeMonitor([], { timeoutMs: 0, freshnessMs: 1, intervalMs: 1 }); return false; } catch { return true; } })(), 'a monitor refuses a non-positive policy');

    const noEvidence = makeRuntimeReadiness({ engineVerifiedLive: true, orchestratorVerifiedLive: true });
    assert(!noEvidence.canExecute && !noEvidence.engine.verifiedLive && noEvidence.engine.verification.status === 'NOT_PROBED' && noEvidence.engine.evidence === null, 'a verifiedLive flag without evidence is not verification');
    const unverifiedBlock = runtimeExecutionBlocker(noEvidence);
    assert(unverifiedBlock?.code === 'NOT_CONFIGURED' && /hermes/i.test(unverifiedBlock.message) && /hatchet/i.test(unverifiedBlock.message), 'unproven components block launch as NOT_CONFIGURED, naming each component');
    const failedBlock = runtimeExecutionBlocker(makeRuntimeReadiness({ engineVerifiedLive: true, engineEvidence: 'qa-fixture:a', orchestratorFailure: 'TIMEOUT' }));
    assert(failedBlock?.code === 'UNAVAILABLE' && /hatchet/i.test(failedBlock.message) && !/hermes/i.test(failedBlock.message), 'a FAILED probe blocks launch as UNAVAILABLE and names only the failing component');
    const both = makeRuntimeReadiness({ engineVerifiedLive: true, engineEvidence: 'qa-fixture:a', orchestratorVerifiedLive: true, orchestratorEvidence: 'qa-fixture:b' });
    assert(both.canExecute && runtimeExecutionBlocker(both) === null, 'two evidenced components may execute');
    const summaryKeys = Object.keys(summarizeRuntimeComponent(both.engine)).sort().join(',');
    assert(summaryKeys === 'checkedAt,expiresAt,failure,status', 'customer summary is exactly {status, failure, checkedAt, expiresAt} (no endpoint, identity or evidence ref), got ' + summaryKeys);
    pass('pure rules: clamped probe policy, no verification without evidence, launch blocker codes, customer summary shape');

    // ── Group 2 · monitor: configuration and missing evidence ──────────────────────────────────
    let clock = Date.parse('2026-11-21T12:00:00.000Z');
    const now = () => new Date(clock);
    const newMonitor = (env: NodeJS.ProcessEnv, policy: RuntimeProbePolicy = QA_POLICY) => {
      const created = createRuntimeProbeMonitor(env, { now, policy });
      monitors.push(created);
      return created;
    };

    const empty = newMonitor({});
    const emptyReadiness = record(empty.readiness());
    assert(emptyReadiness.engine.verification.status === 'NOT_CONFIGURED' && emptyReadiness.orchestrator.verification.status === 'NOT_CONFIGURED', 'nothing configured → both NOT_CONFIGURED');
    assert(emptyReadiness.overallState === 'BLOCKED' && !emptyReadiness.canExecute, 'nothing configured → BLOCKED, cannot execute');
    const servedBefore = hermes.served.length + hatchet.served.length;
    await empty.probeAll();
    assert(empty.evidence('hermes') === null && empty.evidence('hatchet') === null, 'probing with nothing configured records no evidence');

    const env: NodeJS.ProcessEnv = { ...runtimeEnvironment(hermes, hatchet), QEYNOX_RUNTIME_VERIFIED_LIVE: 'true', QEYNOX_RUNTIME_VERIFICATION_EVIDENCE: 'operator-says-it-works' };
    const monitor = newMonitor(env);
    const fresh = record(monitor.readiness());
    assert(fresh.engine.configured && fresh.orchestrator.configured, 'fixtures configured for both components');
    assert(fresh.engine.verification.status === 'NOT_PROBED' && fresh.orchestrator.verification.status === 'NOT_PROBED', 'missing evidence → NOT_PROBED for each component: ' + states(fresh));
    assert(fresh.engine.state === 'UNVERIFIED' && fresh.orchestrator.state === 'UNVERIFIED' && fresh.overallState === 'UNVERIFIED', 'missing evidence → UNVERIFIED, never OPERATIONAL');
    assert(!fresh.canExecute && !fresh.engine.verifiedLive && fresh.engine.evidence === null && fresh.orchestrator.evidence === null, 'QEYNOX_RUNTIME_VERIFIED_LIVE=true and an operator evidence string prove nothing');
    assert(!JSON.stringify(fresh).includes('operator-says-it-works') && !JSON.stringify(fresh).includes('live-probe'), 'no operator-supplied or synthetic evidence reference appears');
    assert(hermes.served.length + hatchet.served.length === servedBefore, 'reading readiness is passive: it contacts no runtime');
    pass('monitor: nothing configured is NOT_CONFIGURED; configured without evidence is NOT_PROBED/UNVERIFIED; the operator boolean is ignored');

    // ── Group 3 · Hermes-only, Hatchet-only, both ──────────────────────────────────────────────
    await hatchet.down();
    await monitor.probeAll();
    const hermesOnly = record(monitor.readiness());
    assert(hermesOnly.engine.verification.status === 'VERIFIED' && hermesOnly.engine.verifiedLive && hermesOnly.engine.state === 'OPERATIONAL', 'Hermes-only: Hermes VERIFIED/OPERATIONAL: ' + states(hermesOnly));
    assert(hermesOnly.orchestrator.verification.status === 'FAILED' && hermesOnly.orchestrator.verification.failure === 'UNREACHABLE' && hermesOnly.orchestrator.state === 'BLOCKED', 'Hermes-only: Hatchet FAILED UNREACHABLE/BLOCKED');
    assert(!hermesOnly.canExecute && hermesOnly.overallState === 'BLOCKED' && runtimeExecutionBlocker(hermesOnly)?.code === 'UNAVAILABLE', 'Hermes-only: execution blocked as UNAVAILABLE');
    const hv = hermesOnly.engine.verification;
    assert(hv.identity?.deployment === 'hermes-agent' && hv.identity.version === hermes.version && hv.identity.endpoint === hermes.origin && hv.endpoint === hermes.origin, 'Hermes identity is what the deployment proved: origin, hermes-agent, its reported version');
    assert(/^probe:hermes:[0-9a-f-]{36}$/.test(hv.evidenceRef ?? '') && hermesOnly.engine.evidence === hv.evidenceRef, 'Hermes evidence reference is a unique probe id');
    assert(hv.observedAt === now().toISOString() && hv.expiresAt === new Date(clock + QA_POLICY.freshnessMs).toISOString(), 'Hermes evidence carries its probe timestamp and expiry (observedAt + freshness)');
    assert(hermesOnly.orchestrator.evidence === null && hermesOnly.orchestrator.verification.identity === null && /^probe:hatchet:/.test(hermesOnly.orchestrator.verification.evidenceRef ?? ''), 'Hatchet failure has its own evidence reference and no identity');
    const hermesEvidence = monitor.evidence('hermes');
    assert(hermesEvidence !== null && hermesEvidence.durationMs >= 0 && hermesEvidence.startedAt <= hermesEvidence.observedAt, 'evidence records start, observation and duration');
    pass('Hermes-only success: Hermes VERIFIED with proven identity, Hatchet FAILED separately, execution blocked');

    await hatchet.up();
    hermes.mode = 'auth';
    await monitor.probeAll();
    const hatchetOnly = record(monitor.readiness());
    assert(hatchetOnly.orchestrator.verification.status === 'VERIFIED' && hatchetOnly.orchestrator.state === 'OPERATIONAL', 'Hatchet-only: Hatchet VERIFIED/OPERATIONAL: ' + states(hatchetOnly));
    assert(hatchetOnly.engine.verification.status === 'FAILED' && hatchetOnly.engine.verification.failure === 'AUTH_REJECTED' && hatchetOnly.engine.state === 'BLOCKED', 'Hatchet-only: Hermes FAILED AUTH_REJECTED/BLOCKED');
    assert(!hatchetOnly.canExecute && runtimeExecutionBlocker(hatchetOnly)?.code === 'UNAVAILABLE', 'Hatchet-only: execution blocked as UNAVAILABLE');
    const tv = hatchetOnly.orchestrator.verification;
    assert(tv.identity?.deployment === 'tenant ' + hatchet.tenantId + ' (qa-tenant)' && tv.identity.version === hatchet.version && tv.identity.endpoint === hatchet.apiOrigin, 'Hatchet identity: API origin, the tenant the token names (confirmed by the API), the reported version: ' + JSON.stringify(tv));
    assert(tv.evidenceRef !== hatchetOnly.engine.verification.evidenceRef && tv.evidenceRef !== hv.evidenceRef, 'each probe run has its own evidence reference');
    pass('Hatchet-only success: Hatchet VERIFIED with tenant identity, Hermes FAILED separately, execution blocked');

    hermes.mode = 'ok';
    await monitor.probeAll();
    const verified = record(monitor.readiness());
    assert(verified.canExecute && verified.overallState === 'OPERATIONAL' && runtimeExecutionBlocker(verified) === null, 'both verified → OPERATIONAL and canExecute: ' + states(verified));
    assert(verified.engine.evidence !== verified.orchestrator.evidence && Boolean(verified.engine.evidence) && Boolean(verified.orchestrator.evidence), 'both verified with separate evidence');
    pass('both verified: OPERATIONAL, canExecute, separate evidence references');

    // ── Group 4 · stale evidence (injected clock) ──────────────────────────────────────────────
    const verifiedAt = clock;
    clock = verifiedAt + QA_POLICY.freshnessMs - 1;
    assert(monitor.readiness().canExecute, 'evidence is still valid 1 ms before it expires');
    clock = verifiedAt + QA_POLICY.freshnessMs;
    const stale = record(monitor.readiness());
    assert(stale.engine.verification.status === 'STALE' && stale.orchestrator.verification.status === 'STALE', 'at expiresAt both components are STALE: ' + states(stale));
    assert(stale.engine.state === 'UNVERIFIED' && !stale.engine.verifiedLive && stale.engine.evidence === null && !stale.canExecute, 'stale evidence is UNVERIFIED and cannot execute');
    assert(stale.engine.verification.evidenceRef === verified.engine.evidence, 'a STALE status still names the expired evidence it was derived from');
    assert(runtimeExecutionBlocker(stale)?.code === 'NOT_CONFIGURED', 'stale evidence blocks launch (NOT_CONFIGURED: unproven, not failed)');
    clock = verifiedAt - 10 * 60_000;
    assert(monitor.readiness().engine.verification.status === 'STALE', 'evidence observed in the future (clock skew beyond tolerance) is not trusted');
    clock = verifiedAt + QA_POLICY.freshnessMs + 5_000;
    const refreshed = record(await monitor.freshReadiness());
    assert(refreshed.canExecute && refreshed.engine.evidence !== verified.engine.evidence, 'freshReadiness re-probes stale components and verifies again with new evidence');
    const healthCalls = hermes.count('/health');
    const again = await monitor.freshReadiness();
    assert(again.canExecute && hermes.count('/health') === healthCalls, 'freshReadiness does not re-probe components that are still VERIFIED');
    pass('stale evidence: valid until expiresAt, STALE/UNVERIFIED at expiry, future evidence distrusted, freshReadiness re-verifies');

    // ── Group 5 · timeout, independence, in-flight sharing ─────────────────────────────────────
    const hatchetBefore = monitor.evidence('hatchet')!;
    hermes.mode = 'hang';
    const t0 = Date.now();
    await monitor.probe('hermes');
    const elapsed = Date.now() - t0;
    const timedOut = record(monitor.readiness());
    assert(timedOut.engine.verification.status === 'FAILED' && timedOut.engine.verification.failure === 'TIMEOUT', 'a hanging Hermes is FAILED TIMEOUT: ' + states(timedOut));
    assert(elapsed < 2_000 && (monitor.evidence('hermes')?.durationMs ?? 99_999) < 2_000, 'the probe is bounded by the 250 ms policy (took ' + elapsed + ' ms)');
    assert(monitor.evidence('hatchet') === hatchetBefore && timedOut.orchestrator.verification.status === 'VERIFIED', 'the Hermes timeout leaves Hatchet evidence untouched and VERIFIED');
    assert(!timedOut.canExecute && runtimeExecutionBlocker(timedOut)?.code === 'UNAVAILABLE', 'a timeout blocks execution as UNAVAILABLE');
    hermes.mode = 'ok';
    await monitor.probe('hermes');
    hatchet.mode = 'hang';
    await monitor.probeAll();
    const hatchetTimeout = record(monitor.readiness());
    assert(hatchetTimeout.orchestrator.verification.failure === 'TIMEOUT' && hatchetTimeout.engine.verification.status === 'VERIFIED', 'a hanging Hatchet times out while Hermes verifies in the same round: ' + states(hatchetTimeout));
    hatchet.mode = 'ok';
    const callsBefore = hermes.count('/health');
    const [first, second] = await Promise.all([monitor.probe('hermes'), monitor.probe('hermes')]);
    assert(first !== null && first === second && hermes.count('/health') === callsBefore + 1, 'concurrent probes of one component share one in-flight probe');
    await monitor.probeAll();
    assert(monitor.readiness().canExecute, 'both verified again after the timeouts clear');
    pass('timeout: 250 ms bound, FAILED TIMEOUT per component, the other component unaffected; in-flight probes are shared');

    // ── Group 6 · restarts ─────────────────────────────────────────────────────────────────────
    const restarted = newMonitor(env);
    const afterRestart = record(restarted.readiness());
    assert(afterRestart.engine.verification.status === 'NOT_PROBED' && afterRestart.orchestrator.verification.status === 'NOT_PROBED' && !afterRestart.canExecute, 'process restart: a new monitor holds no evidence (NOT_PROBED) although the previous one was verified');
    assert(monitor.readiness().canExecute, 'the old monitor kept its own evidence (evidence is per process, never shared or persisted)');
    await hermes.down();
    await restarted.probeAll();
    const hermesDown = record(restarted.readiness());
    assert(hermesDown.engine.verification.failure === 'UNREACHABLE' && hermesDown.orchestrator.verification.status === 'VERIFIED', 'Hermes restarting (down): FAILED UNREACHABLE; Hatchet still VERIFIED');
    await hermes.restart('0.20.1-qa');
    await restarted.probeAll();
    const hermesBack = record(restarted.readiness());
    assert(hermesBack.canExecute && hermesBack.engine.verification.identity?.version === '0.20.1-qa', 'Hermes back with a new version: VERIFIED with the newly reported identity');
    await hatchet.restart('v0.70.2-qa');
    await restarted.probeAll();
    assert(restarted.readiness().orchestrator.verification.identity?.version === 'v0.70.2-qa', 'Hatchet restarted with a new version: identity follows the deployment: ' + JSON.stringify(restarted.readiness().orchestrator.verification));
    await hatchet.grpcDown();
    await restarted.probe('hatchet');
    const grpcDown = record(restarted.readiness());
    assert(grpcDown.orchestrator.verification.failure === 'UNREACHABLE' && (grpcDown.orchestrator.verification.detail ?? '').includes('gRPC'), 'Hatchet API up but engine gRPC down: FAILED UNREACHABLE (gRPC)');
    await hatchet.grpcUp();
    await restarted.probe('hatchet');
    assert(restarted.readiness().canExecute, 'gRPC back: verified again');
    pass('restart: a new process starts NOT_PROBED; runtime restarts fail then re-verify with the new identity');

    // ── Group 7 · configuration change ─────────────────────────────────────────────────────────
    const originalKey = env.HERMES_API_KEY;
    env.HERMES_API_KEY = 'qa-rotated-key-' + randomUUID();
    const rotated = record(restarted.readiness());
    assert(rotated.engine.verification.status === 'TARGET_CHANGED' && rotated.engine.state === 'UNVERIFIED' && !rotated.canExecute, 'a rotated Hermes key invalidates its evidence (TARGET_CHANGED)');
    assert(rotated.orchestrator.verification.status === 'VERIFIED', 'the Hermes change does not touch Hatchet');
    await restarted.probe('hermes');
    assert(restarted.readiness().engine.verification.failure === 'AUTH_REJECTED', 'the rotated key is then probed against the deployment (rejected here)');
    env.HERMES_API_KEY = originalKey;
    await restarted.probe('hermes');
    const originalBase = env.HERMES_API_BASE_URL;
    env.HERMES_API_BASE_URL = 'http://localhost:' + new URL(hermes.origin).port;
    assert(restarted.readiness().engine.verification.status === 'TARGET_CHANGED', 'a different Hermes endpoint invalidates its evidence');
    env.HERMES_API_BASE_URL = originalBase;
    const originalToken = env.HATCHET_CLIENT_TOKEN;
    env.HATCHET_CLIENT_HOST_PORT = '127.0.0.1:1';
    const hatchetChanged = record(restarted.readiness());
    assert(hatchetChanged.orchestrator.verification.status === 'TARGET_CHANGED' && hatchetChanged.engine.verification.status === 'VERIFIED', 'a different Hatchet gRPC address invalidates Hatchet evidence only');
    delete env.HATCHET_CLIENT_HOST_PORT;
    delete env.HATCHET_CLIENT_TOKEN;
    const hatchetRemoved = record(restarted.readiness());
    assert(hatchetRemoved.orchestrator.verification.status === 'NOT_CONFIGURED' && hatchetRemoved.orchestrator.state === 'BLOCKED' && hatchetRemoved.orchestrator.missing.includes('HATCHET_CLIENT_TOKEN'), 'removing the Hatchet token: NOT_CONFIGURED/BLOCKED');
    await restarted.probe('hatchet');
    env.HATCHET_CLIENT_TOKEN = originalToken;
    assert(restarted.readiness().orchestrator.verification.status === 'NOT_PROBED', 'probing while unconfigured drops old evidence: re-adding the token must be verified from scratch');
    delete env.HERMES_NATIVE_TOOLS_ISOLATED;
    const notAttested = record(restarted.readiness());
    assert(notAttested.engine.state === 'BLOCKED' && !notAttested.engine.attested && notAttested.engine.missing.includes('HERMES_NATIVE_TOOLS_ISOLATED=true') && !notAttested.canExecute, 'a missing operator attestation blocks Hermes even with fresh evidence');
    env.HERMES_NATIVE_TOOLS_ISOLATED = 'true';
    await restarted.probeAll();
    assert(restarted.readiness().canExecute, 'restored configuration verifies again');
    pass('configuration change: rotated key / endpoint / gRPC address → TARGET_CHANGED per component; removed config → NOT_CONFIGURED; attestations stay required');

    // ── Group 8 · failure classification ───────────────────────────────────────────────────────
    const classify = new Map<string, string>();
    for (const mode of ['tools-enabled', 'not-hermes', 'unhealthy', 'model-missing', 'echo-key-401'] as const) {
      hermes.mode = mode;
      await restarted.probe('hermes');
      internalEvidence.push(JSON.stringify(restarted.evidence('hermes')));
      const r = record(restarted.readiness());
      classify.set('hermes:' + mode, String(r.engine.verification.failure));
      assert(r.orchestrator.verification.status === 'VERIFIED', 'Hermes ' + mode + ' leaves Hatchet VERIFIED');
    }
    hermes.mode = 'ok';
    for (const mode of ['auth', 'unready', 'wrong-tenant', 'unknown-tenant'] as const) {
      hatchet.mode = mode;
      await restarted.probe('hatchet');
      internalEvidence.push(JSON.stringify(restarted.evidence('hatchet')));
      const r = record(restarted.readiness());
      classify.set('hatchet:' + mode, String(r.orchestrator.verification.failure));
      assert(r.engine.verification.status === 'FAILED' || r.engine.verification.status === 'VERIFIED', 'Hatchet ' + mode + ' leaves Hermes evidence alone');
    }
    hatchet.mode = 'ok';
    const expected: Record<string, string> = {
      'hermes:tools-enabled': 'ISOLATION_NOT_EVIDENCED', 'hermes:not-hermes': 'IDENTITY_MISMATCH', 'hermes:unhealthy': 'UNHEALTHY',
      'hermes:model-missing': 'MODEL_NOT_ADVERTISED', 'hermes:echo-key-401': 'AUTH_REJECTED',
      'hatchet:auth': 'AUTH_REJECTED', 'hatchet:unready': 'UNHEALTHY', 'hatchet:wrong-tenant': 'IDENTITY_MISMATCH', 'hatchet:unknown-tenant': 'IDENTITY_MISMATCH',
    };
    for (const [key, failure] of Object.entries(expected)) assert(classify.get(key) === failure, 'classification ' + key + ' → ' + failure + ', got ' + String(classify.get(key)));
    await restarted.probeAll();
    assert(restarted.readiness().canExecute, 'verified again after the failure matrix');
    pass('failure classification: isolation, identity, health, model, auth, readiness and tenant failures are distinct and per component');

    // ── Group 9 · credential hygiene of the probes themselves ──────────────────────────────────
    assert(hermes.served.filter(entry => entry.path === '/health').every(entry => entry.authorization === undefined), 'Hermes /health is probed without credentials');
    assert(hatchet.served.filter(entry => entry.path === '/api/ready' || entry.path === '/api/v1/version').every(entry => entry.authorization === undefined), 'Hatchet readiness and version are probed without credentials');
    assert(hatchet.served.some(entry => entry.path === '/api/v1/tenants/' + hatchet.tenantId && entry.authorization === 'Bearer ' + hatchet.token), 'the Hatchet token is sent only to its own tenant endpoint');
    const userinfo = newMonitor({ ...runtimeEnvironment(hermes, hatchet), HERMES_API_BASE_URL: 'http://qa-user:qa-userinfo-secret@127.0.0.1:' + new URL(hermes.origin).port });
    await userinfo.probeAll();
    const userinfoReadiness = record(userinfo.readiness());
    assert(!JSON.stringify(userinfoReadiness).includes('qa-userinfo-secret') && !JSON.stringify(userinfo.evidence('hermes')).includes('qa-userinfo-secret'), 'credentials embedded in an endpoint URL never reach evidence (origin only)');
    for (const m of [monitor, restarted, userinfo]) internalEvidence.push(JSON.stringify([m.evidence('hermes'), m.evidence('hatchet')]));
    pass('probe hygiene: unauthenticated health checks, the token only to its tenant endpoint, URL credentials stripped');

    // ── Group 10 · real database: launch gate in OperationExecutionService ─────────────────────
    qa = await createIsolatedQaDatabase();
    process.env.DATABASE_URL = qa.url;
    process.env.QEYNOX_ALLOW_REGISTRATION = 'true';
    process.env.QEYNOX_COMMERCE_MODE = 'BETA_FREE';
    process.env.QEYNOX_RUNTIME_PROBES = 'off';
    for (const [key, value] of Object.entries(runtimeEnvironment(hermes, hatchet))) process.env[key] = value;
    delete process.env.HATCHET_CLIENT_API_URL;
    delete process.env.HATCHET_CLIENT_HOST_PORT;
    // The operator boolean is set on purpose: it must be ignored end to end.
    process.env.QEYNOX_RUNTIME_VERIFIED_LIVE = 'true';
    process.env.QEYNOX_RUNTIME_VERIFICATION_EVIDENCE = 'operator-says-it-works';
    const report = await runMigrations(qa.url);
    assert(report.applied.length === report.total, 'disposable database fully migrated');
    connection = connectDatabase(qa.url);
    const db = connection.db;
    const store = new QeyNoxStore(db);
    const platformPassword = 'runtime-verification-qa-passphrase';
    const operator = { id: 'runtime-verification-qa-admin', email: 'runtime-verification-admin@example.invalid' };
    const credential = await hashPassword(platformPassword);
    await db.insert(identityUsers).values({ id: operator.id, email: operator.email, locale: 'en' });
    await db.insert(identityCredentials).values({ userId: operator.id, salt: credential.salt, passwordHash: credential.hash });
    await db.insert(platformAdminAssignments).values({ id: 'runtime-verification-qa-assignment', userId: operator.id, role: 'PLATFORM_ADMIN', status: 'ACTIVE', grantedBy: 'QA_FIXTURE', grantReason: 'deterministic runtime verification e2e seed' });

    const boot = async () => {
      const instance = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
      instance.useGlobalFilters(new DomainExceptionFilter());
      await instance.listen(0, '127.0.0.1');
      return { instance, base: 'http://127.0.0.1:' + String((instance.getHttpServer().address() as { port: number }).port) };
    };
    const booted = await boot();
    app = booted.instance;
    const base = booted.base;
    // Fresh API monitor with the QA policy and the injected clock (exactly a process restart).
    const apiMonitor = restartApiRuntimeMonitor({ now, policy: QA_POLICY });
    assert(apiRuntimeMonitor() === apiMonitor, 'the API serves readiness from the restarted monitor');

    const registered = await http(base, '/v1/auth/register', { json: { email: 'qa-a2107-' + randomUUID().slice(0, 8) + '@example.invalid', password: 'qa-a2107-strong-password', workspaceName: 'QA A21.07 Runtime' } });
    assert(registered.status === 201, 'registered a workspace owner over HTTP, got ' + String(registered.status));
    const auth = registered.body as unknown as { token: string; userId: string; workspaceId: string };
    const owner: Principal = { userId: auth.userId as ID, workspaceId: auth.workspaceId as ID, roles: ['OWNER'] };
    const headers = { authorization: 'Bearer ' + auth.token, 'x-qeynox-workspace': auth.workspaceId };
    const { grantId } = await seedQaBetaGrant(db, auth.workspaceId, { missionQuota: 10, concurrentLimit: 10 });
    process.env.QEYNOX_OPERATOR_USER_IDS = auth.userId;
    await new ConfigurationService(store).apply(owner, {
      idempotencyKey: 'qa-a2107-config-' + auth.workspaceId.slice(0, 8),
      entries: [
        // Declared only so the readiness view has no non-runtime blocker; no tool is ever called here.
        { domain: 'TOOL', connectorId: 'world-bank', version: '1', status: 'ACTIVE', manifest: { description: 'QA declaration for the documented World Bank indicator adapter', provider: 'World Bank', regions: ['GLOBAL'], operations: ['INDICATOR_RESEARCH'], mode: 'READ_ONLY', licenseNotes: 'QA fixture only; terms must be verified by the operator', termsUrl: 'https://datahelpdesk.worldbank.org/knowledgebase/articles/889392', freshness: { ttlSeconds: 86400, publishedAtSource: 'UNKNOWN' }, rateLimit: { maxPerMinute: 30 }, tools: [{ name: 'indicator', version: '1' }] } },
        { domain: 'BUSINESS_CAPABILITY', slot: 1, version: 1, status: 'ACTIVE', name: 'QA A21.07 Capability', purpose: 'QA-only capability for runtime verification', scope: ['QA A21.07 scope'], allowedTools: [], privacyScopes: [], inputSchemaVersion: 1, outputSchemaVersion: 1, maximumSteps: 5, maximumToolCalls: 2 },
        { domain: 'AGENT_PROFILE', slot: 1, version: 1, status: 'ACTIVE', title: 'QA A21.07 Business Agent', systemInstructions: 'QA-only business profile: summarize only recorded observations and never use native tools.', skillRefs: [], allowedTools: [], permittedContextKeys: [], maxOutputTokens: 256, maxIterations: 2 },
        { domain: 'VERIFICATION_POLICY', capabilityId: 'capability-slot-1-v1', version: 1, status: 'ACTIVE', minimumSources: 1, maxAgeDays: 30, approvedProviders: ['world-bank'], humanReviewRequired: false, validFrom: new Date(Date.now() - 86_400_000).toISOString() },
        { domain: 'RAAS_OFFER', offerId: 'qa-a2107-free-offer', version: 1, status: 'ACTIVE', label: 'QA A21.07 Free Offer', capabilityIds: ['capability-slot-1-v1'], deliverableSchemaVersion: 1, scope: ['QA A21.07 scope'], exclusions: [], regions: ['GLOBAL'], locales: ['en'], termsVersion: 'qa-a2107-terms', currency: 'USD', amountMinor: 0, taxPolicy: 'CONFIGURED', isExplicitlyFree: true },
        { domain: 'BUDGET_POLICY', policyId: 'default', version: 1, status: 'ACTIVE', currency: 'USD', maxMoneyMinor: 100_000, maxAgentCalls: 50, maxToolCalls: 50, maxDurationSeconds: 3600, maxConcurrent: 10, unitMaxMinor: { hermes: 200 } },
      ],
    } as never);
    const planning = new PlanningService(store);
    const commerce = new CommerceService(store);
    const prepare = async (label: string) => {
      const operation = await store.createOperation(owner, 'QA A21.07 ' + label, 'QA A21.07 runtime verification objective ' + label, []);
      const plan = await planning.create(owner, operation.id, operation.version, [{ title: 'QA A21.07 step', description: 'QA A21.07 step description', capabilityId: 'capability-slot-1-v1' as ID, dependsOnIndices: [], intent: 'RESEARCH' }]);
      const quote = await commerce.quote(owner, operation.id, 'qa-a2107-free-offer', plan.revision.id) as { id: string };
      await commerce.accept(owner, quote.id as ID, 'qa-a2107-accept-' + label + '-' + randomUUID().slice(0, 8));
      return store.getOperation(owner, operation.id);
    };
    const missionsUsed = async () => (await db.select().from(betaGrants).where(eq(betaGrants.id, grantId)))[0]!.missionsUsed;
    const attempts = async (operationId: string) => (await db.execute(sql`select count(*)::int as n from step_attempts where operation_id = ${operationId}`)).rows[0] as { n: number };
    const outbox = async (operationId: string) => (await db.execute(sql`select count(*)::int as n from outbox where operation_id = ${operationId}`)).rows[0] as { n: number };

    const gateMonitor = newMonitor(env);
    const gated = new OperationExecutionService(store, () => gateMonitor.readiness());
    const unitOp = await prepare('unit-gate');
    const usedBefore = await missionsUsed();
    const unproven = await expectDomainError('NOT_CONFIGURED', () => gated.start(owner, unitOp.id, unitOp.version, 'qa-a2107-unit-' + randomUUID()), 'launch with no evidence');
    assert(/hermes/i.test(unproven.message) && /hatchet/i.test(unproven.message), 'the refusal names both unproven components');
    hermes.mode = 'auth';
    await gateMonitor.probeAll();
    await expectDomainError('UNAVAILABLE', () => gated.start(owner, unitOp.id, unitOp.version, 'qa-a2107-unit-' + randomUUID()), 'launch with Hermes FAILED, Hatchet VERIFIED');
    hermes.mode = 'ok';
    await hatchet.down();
    await gateMonitor.probeAll();
    await expectDomainError('UNAVAILABLE', () => gated.start(owner, unitOp.id, unitOp.version, 'qa-a2107-unit-' + randomUUID()), 'launch with Hermes VERIFIED, Hatchet FAILED');
    await hatchet.up();
    assert(await missionsUsed() === usedBefore && (await attempts(unitOp.id)).n === 0 && (await outbox(unitOp.id)).n === 0, 'refused launches consume no beta allowance and create no attempt or dispatch intent');
    assert((await store.getOperation(owner, unitOp.id)).status === unitOp.status, 'refused launches leave the operation status unchanged');
    await gateMonitor.probeAll();
    const startedUnit = await gated.start(owner, unitOp.id, unitOp.version, 'qa-a2107-unit-' + randomUUID()) as { attemptId: string };
    assert(typeof startedUnit.attemptId === 'string' && await missionsUsed() === usedBefore + 1 && (await outbox(unitOp.id)).n === 1, 'with both verified the launch is admitted, consuming one allowance and queuing one dispatch');
    pass('launch gate: NOT_CONFIGURED without evidence, UNAVAILABLE when either probe failed, nothing consumed until both are verified');

    // ── Group 11 · HTTP: readiness, start, journey, operator capabilities ──────────────────────
    const login = await http(base, '/v1/platform/auth/login', { json: { email: operator.email, password: platformPassword } });
    assert(login.status === 201, 'platform admin login');
    const admin = { authorization: 'Bearer ' + (login.body as { token: string }).token };
    type Summary = { status: string; failure: string | null; checkedAt: string | null; expiresAt: string | null };
    type Prereq = { ok: boolean; state: string; verifiedLive: boolean; verification: Summary };
    type Readiness = { canStart: boolean; operationalState: string; blockers: { code: string; detail: string }[]; prerequisites: { engine: Prereq; orchestrator: Prereq } };
    type JourneyRuntime = { canExecute: boolean; state: string; engine: Summary; orchestrator: Summary };
    const readinessOf = async (operationId: string) => {
      const response = await http(base, '/v1/operations/' + operationId + '/readiness', { headers });
      assert(response.status === 200, 'readiness read, got ' + String(response.status));
      return response.body as unknown as Readiness;
    };
    const journey = async () => {
      const response = await http(base, '/v1/workspaces/current/beta-access/journey', { headers });
      assert(response.status === 200, 'journey read, got ' + String(response.status));
      return response.body as unknown as { state: string; canLaunch: boolean; runtime: JourneyRuntime };
    };
    const start = (operationId: string, version: number) => http(base, '/v1/operations/' + operationId + '/start', { headers, json: { expectedVersion: version, idempotencyKey: 'qa-a2107-http-' + randomUUID() } });
    const runtimeCodes = (r: Readiness) => r.blockers.map(blocker => blocker.code).filter(code => code.startsWith('ENGINE_') || code.startsWith('ORCHESTRATOR_')).sort().join(',');

    const httpOp = await prepare('http');
    const r0 = await readinessOf(httpOp.id);
    assert(r0.blockers.every(blocker => blocker.code.startsWith('ENGINE_') || blocker.code.startsWith('ORCHESTRATOR_')), 'the fixture leaves only runtime blockers, got ' + JSON.stringify(r0.blockers));
    assert(runtimeCodes(r0) === 'ENGINE_UNVERIFIED,ORCHESTRATOR_UNVERIFIED' && r0.operationalState === 'UNVERIFIED' && !r0.canStart, 'HTTP readiness without evidence: ENGINE_UNVERIFIED + ORCHESTRATOR_UNVERIFIED, UNVERIFIED, cannot start (operator boolean set)');
    assert(r0.prerequisites.engine.verification.status === 'NOT_PROBED' && r0.prerequisites.orchestrator.verification.status === 'NOT_PROBED' && !r0.prerequisites.engine.ok, 'HTTP readiness prerequisites carry per-component verification NOT_PROBED');
    assert(Object.keys(r0.prerequisites.engine.verification).sort().join(',') === 'checkedAt,expiresAt,failure,status', 'customer readiness exposes only the verification summary');
    const j0 = await journey();
    assert(j0.state === 'RUNTIME_UNAVAILABLE' && !j0.canLaunch && !j0.runtime.canExecute && j0.runtime.engine.status === 'NOT_PROBED' && j0.runtime.orchestrator.status === 'NOT_PROBED', 'beta journey: RUNTIME_UNAVAILABLE with both components NOT_PROBED');
    const s0 = await start(httpOp.id, httpOp.version);
    assert(s0.status === 503 && (s0.body.error as { code: string }).code === 'NOT_CONFIGURED', 'HTTP start without evidence → 503 NOT_CONFIGURED, got ' + String(s0.status));

    await hatchet.down();
    await apiMonitor.probeAll();
    const r1 = await readinessOf(httpOp.id);
    assert(runtimeCodes(r1) === 'ORCHESTRATOR_UNAVAILABLE' && r1.operationalState === 'BLOCKED' && !r1.canStart, 'HTTP readiness Hermes-only: ORCHESTRATOR_UNAVAILABLE, BLOCKED');
    assert(r1.prerequisites.engine.ok && r1.prerequisites.engine.verification.status === 'VERIFIED' && r1.prerequisites.orchestrator.verification.status === 'FAILED' && r1.prerequisites.orchestrator.verification.failure === 'UNREACHABLE', 'HTTP prerequisites: engine VERIFIED, orchestrator FAILED UNREACHABLE');
    const j1 = await journey();
    assert(j1.state === 'RUNTIME_UNAVAILABLE' && j1.runtime.engine.status === 'VERIFIED' && j1.runtime.orchestrator.status === 'FAILED' && j1.runtime.orchestrator.failure === 'UNREACHABLE', 'beta journey: engine VERIFIED, orchestrator FAILED');
    const s1 = await start(httpOp.id, httpOp.version);
    assert(s1.status === 502 && (s1.body.error as { code: string }).code === 'UNAVAILABLE', 'HTTP start with Hatchet down → 502 UNAVAILABLE, got ' + String(s1.status));
    const capabilities = await http(base, '/v1/platform/capabilities', { headers: admin });
    assert(capabilities.status === 200, 'operator capabilities read, got ' + String(capabilities.status));
    const operatorRuntime = (capabilities.body as unknown as { runtime: RuntimeReadiness }).runtime;
    assert(operatorRuntime.engine.verification.identity?.deployment === 'hermes-agent' && /^probe:hermes:/.test(operatorRuntime.engine.verification.evidenceRef ?? ''), 'operator view: Hermes identity and evidence reference');
    assert(operatorRuntime.orchestrator.verification.status === 'FAILED' && operatorRuntime.orchestrator.verification.failure === 'UNREACHABLE' && operatorRuntime.orchestrator.verification.endpoint === hatchet.apiOrigin, 'operator view: Hatchet failure with its endpoint');
    assert(!JSON.stringify(operatorRuntime).includes('targetFingerprint'), 'operator view does not expose the configuration fingerprint');

    await hatchet.up();
    hermes.mode = 'hang';
    await apiMonitor.probeAll();
    const r2 = await readinessOf(httpOp.id);
    assert(runtimeCodes(r2) === 'ENGINE_UNAVAILABLE' && r2.prerequisites.engine.verification.failure === 'TIMEOUT' && r2.prerequisites.orchestrator.verification.status === 'VERIFIED', 'HTTP readiness Hatchet-only (Hermes timeout): ENGINE_UNAVAILABLE TIMEOUT, orchestrator VERIFIED');
    const s2 = await start(httpOp.id, httpOp.version);
    assert(s2.status === 502, 'HTTP start with Hermes timing out → 502, got ' + String(s2.status));

    hermes.mode = 'ok';
    await apiMonitor.probeAll();
    const r3 = await readinessOf(httpOp.id);
    assert(r3.canStart && r3.operationalState === 'OPERATIONAL' && r3.blockers.length === 0 && r3.prerequisites.engine.ok && r3.prerequisites.orchestrator.ok, 'HTTP readiness both verified: OPERATIONAL, canStart, no blockers');
    const j3 = await journey();
    assert(j3.state === 'ACTIVE' && j3.canLaunch && j3.runtime.canExecute && j3.runtime.engine.status === 'VERIFIED' && j3.runtime.orchestrator.status === 'VERIFIED' && j3.runtime.engine.expiresAt !== null, 'beta journey: ACTIVE with both VERIFIED and an expiry');
    const usedBeforeHttp = await missionsUsed();
    const s3 = await start(httpOp.id, httpOp.version);
    assert(s3.status === 201 && await missionsUsed() === usedBeforeHttp + 1, 'HTTP start with both verified → 201 and one allowance consumed, got ' + String(s3.status));

    const staleOp = await prepare('stale');
    clock += QA_POLICY.freshnessMs;
    const r4 = await readinessOf(staleOp.id);
    assert(runtimeCodes(r4) === 'ENGINE_UNVERIFIED,ORCHESTRATOR_UNVERIFIED' && r4.prerequisites.engine.verification.status === 'STALE' && r4.blockers.some(blocker => blocker.detail.includes('expired')), 'HTTP readiness after the freshness limit: STALE → *_UNVERIFIED (expired)');
    assert((await journey()).runtime.orchestrator.status === 'STALE', 'beta journey reports STALE');
    const s4 = await start(staleOp.id, staleOp.version);
    assert(s4.status === 503, 'HTTP start on stale evidence → 503, got ' + String(s4.status));
    await apiMonitor.probeAll();
    process.env.HERMES_API_KEY = 'qa-rotated-key-' + randomUUID();
    const r5 = await readinessOf(staleOp.id);
    assert(runtimeCodes(r5) === 'ENGINE_UNVERIFIED' && r5.blockers.some(blocker => blocker.detail.includes('configuration changed')), 'HTTP readiness after a key rotation: ENGINE_UNVERIFIED (configuration changed)');
    assert((await journey()).runtime.engine.status === 'TARGET_CHANGED', 'beta journey reports TARGET_CHANGED');
    process.env.HERMES_API_KEY = hermes.key;
    assert((await readinessOf(staleOp.id)).canStart, 'restoring the verified configuration restores the evidence binding');
    restartApiRuntimeMonitor({ now, policy: QA_POLICY });
    const r6 = await readinessOf(staleOp.id);
    assert(runtimeCodes(r6) === 'ENGINE_UNVERIFIED,ORCHESTRATOR_UNVERIFIED' && r6.prerequisites.engine.verification.status === 'NOT_PROBED', 'HTTP readiness after an API runtime-monitor restart: NOT_PROBED again');
    pass('HTTP: readiness blockers and verification per component, start 503/502/201, journey summaries, operator evidence, stale, key rotation and restart');

    // ── Group 12 · boot lifecycle starts background probing ────────────────────────────────────
    await app.close();
    app = undefined;
    delete process.env.QEYNOX_RUNTIME_PROBES;
    restartApiRuntimeMonitor({ policy: QA_POLICY });
    const rebooted = await boot();
    app = rebooted.instance;
    let probed: JourneyRuntime | null = null;
    for (let i = 0; i < 50; i++) {
      const response = await http(rebooted.base, '/v1/workspaces/current/beta-access/journey', { headers });
      const runtime = (response.body as unknown as { runtime: JourneyRuntime }).runtime;
      if (runtime.engine.status === 'VERIFIED' && runtime.orchestrator.status === 'VERIFIED') { probed = runtime; break; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert(probed !== null && probed.canExecute, 'API boot starts background probing: both components verified without any manual probe');
    await app.close();
    app = undefined;
    pass('lifecycle: the API probes both runtimes at boot (QEYNOX_RUNTIME_PROBES=off disables it)');

    // ── Group 13 · no credential anywhere ──────────────────────────────────────────────────────
    const secrets = [hermes.key, hatchet.token, hatchet.token.split('.')[2]!, 'qa-userinfo-secret', 'qa-rotated-key-'];
    const everything = recorded.join('\n');
    const withInternal = everything + '\n' + internalEvidence.join('\n');
    for (const secret of secrets) assert(!withInternal.includes(secret), 'no recorded readiness, evidence or HTTP response contains a credential (' + secret.slice(0, 10) + '…)');
    const leaks = ['targetFingerprint', 'Bearer '].map(needle => [needle, everything.indexOf(needle)] as const).filter(([, at]) => at >= 0);
    assert(leaks.length === 0, 'no fingerprint or authorization header value is ever serialized: ' + leaks.map(([needle, at]) => needle + ' in …' + everything.slice(Math.max(0, at - 200), at + 60)).join(' | '));
    assert(!everything.includes('operator-says-it-works') && !everything.includes('"live-probe"'), 'no operator-supplied or synthetic evidence was ever reported');
    pass('no credential leakage across ' + recorded.length + ' recorded readiness objects and HTTP responses plus ' + internalEvidence.length + ' raw evidence snapshots');

    console.log('RESULT: qa:runtime-verification PASS: ' + groups + ' groups, ' + assertions + ' assertions in ' + (Date.now() - startedAt) + ' ms');
  } finally {
    for (const m of monitors) m.stop();
    apiRuntimeMonitor().stop();
    if (app) await app.close().catch(() => undefined);
    await hermes.down().catch(() => undefined);
    await hatchet.down().catch(() => undefined);
    if (connection) await connection.pool.end().catch(() => undefined);
    if (qa) await qa.drop().catch(() => undefined);
    for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}

main().catch(error => {
  console.error('FAIL: ' + (error instanceof Error ? error.stack ?? error.message : String(error)));
  process.exitCode = 1;
});

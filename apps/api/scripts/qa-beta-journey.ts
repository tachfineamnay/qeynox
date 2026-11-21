/**
 * MISSION A21.04 — free-beta customer journey: real PostgreSQL + real HTTP API verification.
 *
 * Verifies `GET /v1/workspaces/current/beta-access/journey`, the read model behind every free-beta
 * customer surface (catalogue, service detail, mission creation, quote acceptance, launch, the payment
 * panel replacement and MyDash):
 *   1. Pure state precedence (`journeyState`) for every state and tie-break.
 *   2. Session required; tenant-scoped (a spoofed workspace header is refused); readable by any ACTIVE
 *      member; `canActivate` mirrors the activation rule (single OWNER/ADMIN role only).
 *   3. Every customer state from real records under QEYNOX_COMMERCE_MODE=BETA_FREE: NOT_ENROLLED,
 *      INVITATION_PENDING, RUNTIME_UNAVAILABLE, ACTIVE, CONCURRENT_LIMIT_REACHED, QUOTA_EXHAUSTED
 *      (missions and provider budget), EXPIRED, REVOKED — with the allowance, expiry and account status
 *      equal to the stored grant.
 *   4. The pricing facts are constant and truthful: no card, payments unavailable, 0 due today, a 100%
 *      waiver only in BETA_FREE, and `waiverApplies` exactly when the grant is ACTIVE (A21.03 rule).
 *   5. NOT_CONFIGURED: the same ACTIVE grant under the default PAYMENTS_DISABLED mode.
 *   6. The read is side-effect free: no beta grant/event row and no audit row is written by it.
 *
 * HONEST BOUNDARY:
 * - Runtime readiness is the real `apiRuntimeReadiness()`: since A21.07 it is OPERATIONAL only on fresh
 *   probe evidence, so local Hermes/Hatchet QA fixtures are probed by the API's own monitor (no real
 *   deployment is contacted). Expiry is simulated by moving stored
 *   timestamps into the past (the code under test reads the real clock), as in qa:beta-access.
 * - Missions are admitted through the real OperationExecutionService; no worker runs. Provider spend
 *   is reserved through the real BudgetService with QA amounts.
 * - No browser runs here; the web surfaces are covered by the web smoke suite and screenshots.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { eq, sql } from 'drizzle-orm';
import {
  QeyNoxStore, connectDatabase, runMigrations,
  betaGrantEvents, betaGrants, identityCredentials, identityMemberships, identityUsers, platformAdminAssignments, platformAdminAudit,
} from '@qeynox/persistence';
import {
  BudgetService, CommerceService, ConfigurationService, OperationExecutionService, PlanningService, journeyState,
  type WorkspaceBetaStatusView,
} from '@qeynox/application';
import type { ID, Principal } from '@qeynox/domain';
import { AppModule } from '../src/app.module';
import { DomainExceptionFilter } from '../src/transport/domain-exception.filter';
import { hashPassword } from '../src/auth/password';
import { createIsolatedQaDatabase } from './qa-isolated-database';
import { runtimeEnvironment, startVerifiedRuntime, type VerifiedRuntime } from './qa-runtime-fixtures';
import { restartApiRuntimeMonitor } from '../src/operations/runtime-readiness';
import { makeRuntimeReadiness as qaRuntimeFixture } from '@qeynox/application';
// A21.07 QA fixture (test infrastructure only): this suite exercises launches, not runtime probing.
// The launch gate itself is proven against real probes in qa:runtime-verification.
const qaVerifiedRuntime = () => qaRuntimeFixture({ engineVerifiedLive: true, engineEvidence: 'qa-fixture:qa-beta-journey', orchestratorVerifiedLive: true, orchestratorEvidence: 'qa-fixture:qa-beta-journey' });

let assertions = 0;
let groups = 0;
function assert(condition: unknown, message: string): asserts condition {
  assertions++;
  if (!condition) throw new Error('ASSERTION FAILED: ' + message);
}
function pass(message: string): void { groups++; console.log('PASS: ' + message); }
async function http(base: string, path: string, init: { json?: unknown; headers?: Record<string, string> } = {}) {
  const body = init.json === undefined ? undefined : JSON.stringify(init.json);
  const response = await fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(init.headers ?? {}) },
    ...(body === undefined ? {} : { body }),
  });
  const text = await response.text();
  let parsed: unknown = text;
  try { parsed = JSON.parse(text); } catch { /* plain text */ }
  return { status: response.status, body: parsed as Record<string, unknown> };
}

interface RuntimeSummary { status: string; failure: string | null; checkedAt: string | null; expiresAt: string | null }
interface Journey {
  workspaceId: string; state: string; canLaunch: boolean;
  freeBeta: { enabled: boolean; mode: string; cardRequired: boolean; paymentsAvailable: boolean; amountDueTodayMinor: number; waiverPercent: number | null; waiverApplies: boolean };
  account: { status: string; expiresAt: string | null; invitationExpiresAt: string | null; activatedAt: string | null; missionQuota: number | null; missionsUsed: number | null; missionsRemaining: number | null; activeMissions: number; concurrentLimit: number | null; providerBudgetMinor: number | null; providerBudgetRemainingMinor: number | null; currency: string | null; quotaReason: string | null; canActivate: boolean };
  runtime: { canExecute: boolean; state: string; engine: RuntimeSummary; orchestrator: RuntimeSummary };
}

// A21.07: the runtime is operational only on real probe evidence. `runtime` holds local Hermes/Hatchet
// fixtures (QA infrastructure) that the API's own monitor probes; `setRuntime(true)` re-probes them.
let runtime: VerifiedRuntime | undefined;
const setRuntime = async (operational: boolean) => {
  if (!runtime) return;
  if (operational) await runtime.ensure(); else runtime.unset();
};

const platformPassword = 'beta-journey-qa-passphrase';
const operator = { id: 'beta-journey-qa-admin', email: 'beta-journey-admin@example.invalid' };

function statusView(grant: Partial<NonNullable<WorkspaceBetaStatusView['grant']>> | null, activeMissions = 0): WorkspaceBetaStatusView {
  return {
    workspaceId: 'w', eligible: false, blocker: null, activeMissions,
    grant: grant === null ? null : {
      grantId: 'g', status: 'ACTIVE', expiresAt: new Date(Date.now() + 86_400_000).toISOString(), invitationExpiresAt: null,
      missionQuota: 3, missionsUsed: 0, missionsRemaining: 3, concurrentLimit: 2, maxProviderSpendMinor: 500, reservedMinor: 0,
      spentMinor: 0, spendRemainingMinor: 500, currency: 'USD', activatedAt: new Date().toISOString(), ...grant,
    } as NonNullable<WorkspaceBetaStatusView['grant']>,
  };
}

async function main(): Promise<void> {
  if (!process.env.QEYNOX_QA_DATABASE_URL) {
    console.log('BLOCKED: QEYNOX_QA_DATABASE_URL is not set. The beta-journey QA suite requires an isolated PostgreSQL database; no result is claimed.');
    process.exitCode = 1;
    return;
  }
  const startedAt = Date.now();

  // ── Group 1 · pure precedence ──────────────────────────────────────────────────────────────────
  const cases: [string, ReturnType<typeof journeyState>, string, string | null][] = [
    ['disabled wins over everything', journeyState(false, statusView({ status: 'REVOKED' }), false), 'NOT_CONFIGURED', null],
    ['no grant', journeyState(true, statusView(null), true), 'NOT_ENROLLED', null],
    ['invited', journeyState(true, statusView({ status: 'INVITED' }), true), 'INVITATION_PENDING', null],
    ['expired', journeyState(true, statusView({ status: 'EXPIRED' }), true), 'EXPIRED', null],
    ['revoked', journeyState(true, statusView({ status: 'REVOKED' }), true), 'REVOKED', null],
    ['quota before concurrency and runtime', journeyState(true, statusView({ missionsUsed: 3, missionsRemaining: 0 }, 2), false), 'QUOTA_EXHAUSTED', 'MISSIONS'],
    ['provider budget', journeyState(true, statusView({ spentMinor: 500, spendRemainingMinor: 0 }), true), 'QUOTA_EXHAUSTED', 'PROVIDER_BUDGET'],
    ['concurrency before runtime', journeyState(true, statusView({}, 2), false), 'CONCURRENT_LIMIT_REACHED', null],
    ['account fine, runtime down', journeyState(true, statusView({}), false), 'RUNTIME_UNAVAILABLE', null],
    ['all clear', journeyState(true, statusView({}), true), 'ACTIVE', null],
  ];
  for (const [label, actual, state, reason] of cases) assert(actual.state === state && actual.quotaReason === reason, 'precedence: ' + label + ' → ' + state + ', got ' + JSON.stringify(actual));
  pass('journey state precedence: NOT_CONFIGURED → account (NOT_ENROLLED, INVITATION_PENDING, EXPIRED, REVOKED, QUOTA_EXHAUSTED, CONCURRENT_LIMIT_REACHED) → RUNTIME_UNAVAILABLE → ACTIVE');

  const qa = await createIsolatedQaDatabase();
  process.env.DATABASE_URL = qa.url;
  process.env.QEYNOX_ALLOW_REGISTRATION = 'true';
  process.env.QEYNOX_COMMERCE_MODE = 'BETA_FREE';
  runtime = await startVerifiedRuntime();
  await setRuntime(false);
  let connection: ReturnType<typeof connectDatabase> | undefined;
  let app: INestApplication | undefined;
  let disabledApp: INestApplication | undefined;
  try {
    const report = await runMigrations(qa.url);
    assert(report.applied.length === report.total, 'disposable database fully migrated');
    connection = connectDatabase(qa.url);
    const db = connection.db;
    const credential = await hashPassword(platformPassword);
    await db.insert(identityUsers).values({ id: operator.id, email: operator.email, locale: 'en' });
    await db.insert(identityCredentials).values({ userId: operator.id, salt: credential.salt, passwordHash: credential.hash });
    await db.insert(platformAdminAssignments).values({ id: 'beta-journey-qa-assignment', userId: operator.id, role: 'PLATFORM_ADMIN', status: 'ACTIVE', grantedBy: 'QA_FIXTURE', grantReason: 'deterministic beta journey e2e seed' });

    const boot = async () => {
      const instance = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
      instance.useGlobalFilters(new DomainExceptionFilter());
      await instance.listen(0, '127.0.0.1');
      return { instance, base: 'http://127.0.0.1:' + String((instance.getHttpServer().address() as { port: number }).port) };
    };
    const booted = await boot();
    app = booted.instance;
    const base = booted.base;
    const login = await http(base, '/v1/platform/auth/login', { json: { email: operator.email, password: platformPassword } });
    assert(login.status === 201, 'platform admin login');
    const admin = { authorization: 'Bearer ' + (login.body as { token: string }).token };

    const register = async (label: string) => {
      const response = await http(base, '/v1/auth/register', { json: { email: 'qa-a2104-' + label + '-' + randomUUID().slice(0, 8) + '@example.invalid', password: 'qa-a2104-strong-password-' + label, workspaceName: 'QA A21.04 ' + label } });
      assert(response.status === 201, 'registered ' + label);
      const auth = response.body as unknown as { token: string; userId: string; workspaceId: string };
      return {
        userId: auth.userId, workspaceId: auth.workspaceId,
        principal: { userId: auth.userId as ID, workspaceId: auth.workspaceId as ID, roles: ['OWNER'] } as Principal,
        headers: { authorization: 'Bearer ' + auth.token, 'x-qeynox-workspace': auth.workspaceId },
      };
    };
    const a = await register('a');
    const b = await register('b');
    const c = await register('c');
    const d = await register('d');
    const memberUser = await register('member');
    await db.insert(identityMemberships).values({ id: randomUUID(), userId: memberUser.userId, workspaceId: a.workspaceId, role: 'MEMBER', status: 'ACTIVE', joinedAt: new Date() });
    const memberHeaders = { authorization: memberUser.headers.authorization, 'x-qeynox-workspace': a.workspaceId };

    const store = new QeyNoxStore(db);
    process.env.QEYNOX_OPERATOR_USER_IDS = [a, b, c, d].map(owner => owner.userId).join(',');
    const configuration = new ConfigurationService(store);
    const budgetEntry = { domain: 'BUDGET_POLICY', policyId: 'default', version: 1, status: 'ACTIVE', currency: 'USD', maxMoneyMinor: 100_000, maxAgentCalls: 50, maxToolCalls: 50, maxDurationSeconds: 3600, maxConcurrent: 10, unitMaxMinor: { hermes: 200 } };
    const entries = [
      { domain: 'BUSINESS_CAPABILITY', slot: 1, version: 1, status: 'ACTIVE', name: 'QA A21.04 Capability', purpose: 'QA-only capability for the beta journey', scope: ['QA A21.04 scope'], allowedTools: [], privacyScopes: [], inputSchemaVersion: 1, outputSchemaVersion: 1, maximumSteps: 5, maximumToolCalls: 2 },
      { domain: 'RAAS_OFFER', offerId: 'qa-a2104-free-offer', version: 1, status: 'ACTIVE', label: 'QA A21.04 Free Offer', capabilityIds: ['capability-slot-1-v1'], deliverableSchemaVersion: 1, scope: ['QA A21.04 scope'], exclusions: [], regions: ['GLOBAL'], locales: ['en'], termsVersion: 'qa-a2104-terms', currency: 'USD', amountMinor: 0, taxPolicy: 'CONFIGURED', isExplicitlyFree: true },
      budgetEntry,
    ];
    for (const owner of [a, b, c, d]) await configuration.apply(owner.principal, { idempotencyKey: 'qa-a2104-config-' + owner.workspaceId.slice(0, 8), entries } as never);
    const planning = new PlanningService(store);
    const commerce = new CommerceService(store);
    const execution = new OperationExecutionService(store, qaVerifiedRuntime);
    const budgets = new BudgetService(store);
    const launch = async (owner: Principal, label: string) => {
      const operation = await store.createOperation(owner, 'QA A21.04 ' + label, 'QA A21.04 beta journey objective ' + label, []);
      const plan = await planning.create(owner, operation.id, operation.version, [{ title: 'QA A21.04 step', description: 'QA A21.04 step description', capabilityId: 'capability-slot-1-v1' as ID, dependsOnIndices: [], intent: 'RESEARCH' }]);
      const quote = await commerce.quote(owner, operation.id, 'qa-a2104-free-offer', plan.revision.id) as { id: string };
      await commerce.accept(owner, quote.id as ID, 'qa-a2104-accept-' + label + '-' + randomUUID().slice(0, 8));
      const ready = await store.getOperation(owner, operation.id);
      await execution.start(owner, operation.id, ready.version, 'qa-a2104-start-' + randomUUID());
      return operation.id;
    };
    const DAY = 86_400_000;
    const grant = async (workspaceId: string, extra: Record<string, unknown> = {}) => {
      const response = await http(base, '/v1/platform/beta-grants', { headers: admin, json: { workspaceId, expiresAt: new Date(Date.now() + 30 * DAY).toISOString(), missionQuota: 3, concurrentLimit: 2, maxProviderSpendMinor: 500, currency: 'USD', reason: 'QA A21.04 beta journey verification grant', ...extra } });
      assert(response.status === 201, 'grant issued for ' + workspaceId + ', got ' + String(response.status));
      return response.body as unknown as { grant: { grantId: string }; invitationToken: string };
    };
    const activate = async (headers: Record<string, string>, token: string) => {
      const response = await http(base, '/v1/workspaces/current/beta-access/activate', { headers, json: { token } });
      assert(response.status === 201, 'activation, got ' + String(response.status));
    };
    const journey = async (headers: Record<string, string>, at = base) => {
      const response = await http(at, '/v1/workspaces/current/beta-access/journey', { headers });
      assert(response.status === 200, 'journey read, got ' + String(response.status) + ' ' + JSON.stringify(response.body));
      return response.body as unknown as Journey;
    };
    const grantRow = async (grantId: string) => (await db.select().from(betaGrants).where(eq(betaGrants.id, grantId)))[0]!;
    const constantFacts = (view: Journey, enabled: boolean) => {
      assert(view.freeBeta.cardRequired === false && view.freeBeta.paymentsAvailable === false && view.freeBeta.amountDueTodayMinor === 0, view.state + ': no card, no payments, 0 due today');
      assert(view.freeBeta.enabled === enabled && view.freeBeta.mode === (enabled ? 'BETA_FREE' : 'PAYMENTS_DISABLED'), view.state + ': commerce mode reported from the server');
      assert(view.freeBeta.waiverPercent === (enabled ? 100 : null), view.state + ': 100% waiver only in BETA_FREE');
      assert(view.freeBeta.waiverApplies === (enabled && view.account.status === 'ACTIVE'), view.state + ': waiverApplies exactly when BETA_FREE and the grant is ACTIVE');
      assert(view.canLaunch === (view.state === 'ACTIVE'), view.state + ': canLaunch only in ACTIVE');
    };
    const sameAsGrant = async (view: Journey, grantId: string) => {
      const row = await grantRow(grantId);
      assert(view.account.expiresAt === row.expiresAt.toISOString(), view.state + ': expiry equals the stored grant');
      assert(view.account.missionQuota === row.missionQuota && view.account.missionsUsed === row.missionsUsed && view.account.missionsRemaining === Math.max(0, row.missionQuota - row.missionsUsed), view.state + ': allowance equals the stored grant');
      assert(view.account.concurrentLimit === row.concurrentLimit && view.account.providerBudgetMinor === row.maxProviderSpendMinor && view.account.currency === row.currency, view.state + ': limits equal the stored grant');
    };
    pass('fixture: real API in BETA_FREE, one platform admin, four HTTP workspaces and a member, real configuration');

    // ── Group 2 · session, tenancy, roles ──────────────────────────────────────────────────────
    const writesBefore = {
      grants: (await db.select({ n: sql<number>`count(*)::int` }).from(betaGrants))[0]!.n,
      events: (await db.select({ n: sql<number>`count(*)::int` }).from(betaGrantEvents))[0]!.n,
      audit: (await db.select({ n: sql<number>`count(*)::int` }).from(platformAdminAudit))[0]!.n,
    };
    const anonymous = await http(base, '/v1/workspaces/current/beta-access/journey');
    assert(anonymous.status === 401 || anonymous.status === 403, 'anonymous journey read is refused, got ' + String(anonymous.status));
    const notEnrolled = await journey(a.headers);
    assert(notEnrolled.state === 'NOT_ENROLLED' && notEnrolled.account.status === 'NOT_ENROLLED' && notEnrolled.workspaceId === a.workspaceId, 'a workspace without a grant is NOT_ENROLLED');
    assert(notEnrolled.account.missionQuota === null && notEnrolled.account.expiresAt === null && notEnrolled.account.canActivate === false, 'NOT_ENROLLED invents no allowance, expiry or activation');
    constantFacts(notEnrolled, true);
    for (let i = 0; i < 3; i++) await journey(a.headers);
    const writesAfter = {
      grants: (await db.select({ n: sql<number>`count(*)::int` }).from(betaGrants))[0]!.n,
      events: (await db.select({ n: sql<number>`count(*)::int` }).from(betaGrantEvents))[0]!.n,
      audit: (await db.select({ n: sql<number>`count(*)::int` }).from(platformAdminAudit))[0]!.n,
    };
    assert(JSON.stringify(writesBefore) === JSON.stringify(writesAfter), 'journey reads write no grant, ledger or audit row');
    const spoof = await http(base, '/v1/workspaces/current/beta-access/journey', { headers: { authorization: b.headers.authorization, 'x-qeynox-workspace': a.workspaceId } });
    assert(spoof.status === 403, 'workspace B cannot read workspace A\'s journey by naming it, got ' + String(spoof.status));
    pass('journey requires a session, is tenant-scoped (spoofed workspace refused) and is side-effect free');

    // ── Group 3 · INVITATION_PENDING → RUNTIME_UNAVAILABLE → ACTIVE ──────────────────────────────
    const grantA = await grant(a.workspaceId);
    const invitedOwner = await journey(a.headers);
    const invitedMember = await journey(memberHeaders);
    assert(invitedOwner.state === 'INVITATION_PENDING' && invitedOwner.account.status === 'INVITED' && invitedOwner.account.canActivate === true, 'OWNER sees INVITATION_PENDING and may activate');
    assert(invitedMember.state === 'INVITATION_PENDING' && invitedMember.account.canActivate === false, 'a MEMBER sees the same state but may not activate (mirrors the activation rule)');
    assert(invitedOwner.account.invitationExpiresAt !== null && invitedOwner.freeBeta.waiverApplies === false, 'the invitation expiry is shown; no waiver applies before activation');
    constantFacts(invitedOwner, true);
    await activate(a.headers, grantA.invitationToken);
    const runtimeDown = await journey(a.headers);
    assert(runtimeDown.state === 'RUNTIME_UNAVAILABLE' && runtimeDown.runtime.canExecute === false && runtimeDown.runtime.state === 'BLOCKED', 'an active grant on an unconfigured runtime is RUNTIME_UNAVAILABLE (runtime BLOCKED)');
    assert(runtimeDown.account.status === 'ACTIVE' && runtimeDown.freeBeta.waiverApplies === true && runtimeDown.account.activatedAt !== null, 'the account is ACTIVE and the waiver applies even while the runtime is down');
    constantFacts(runtimeDown, true);
    await sameAsGrant(runtimeDown, grantA.grant.grantId);
    // Configured, attested and flagged by the operator, but never probed by this process: unverified.
    Object.assign(process.env, runtimeEnvironment(runtime!.hermes, runtime!.hatchet), { QEYNOX_RUNTIME_VERIFIED_LIVE: 'true', QEYNOX_RUNTIME_VERIFICATION_EVIDENCE: 'qa-a2104-operator-flag' });
    restartApiRuntimeMonitor();
    const unverified = await journey(a.headers);
    assert(unverified.state === 'RUNTIME_UNAVAILABLE' && unverified.runtime.state !== 'OPERATIONAL', 'a configured but unverified runtime is still RUNTIME_UNAVAILABLE (never optimistic)');
    assert(unverified.runtime.engine.status === 'NOT_PROBED' && unverified.runtime.orchestrator.status === 'NOT_PROBED', 'A21.07: the operator flag QEYNOX_RUNTIME_VERIFIED_LIVE proves nothing (both components NOT_PROBED)');
    delete process.env.QEYNOX_RUNTIME_VERIFIED_LIVE;
    delete process.env.QEYNOX_RUNTIME_VERIFICATION_EVIDENCE;
    await setRuntime(true);
    const active = await journey(a.headers);
    assert(active.state === 'ACTIVE' && active.canLaunch === true && active.runtime.state === 'OPERATIONAL', 'active grant + operational runtime is ACTIVE');
    assert(active.runtime.engine.status === 'VERIFIED' && active.runtime.orchestrator.status === 'VERIFIED' && active.runtime.engine.expiresAt !== null, 'A21.07: ACTIVE only with both components VERIFIED by a fresh probe');
    assert(active.account.missionsRemaining === 3 && active.account.missionQuota === 3 && active.account.activeMissions === 0, 'ACTIVE reports the full allowance');
    constantFacts(active, true);
    await sameAsGrant(active, grantA.grant.grantId);
    pass('INVITATION_PENDING (owner may activate, member may not) → RUNTIME_UNAVAILABLE (blocked or unverified runtime) → ACTIVE, with the stored allowance and expiry');

    // ── Group 4 · CONCURRENT_LIMIT_REACHED and QUOTA_EXHAUSTED ───────────────────────────────────
    const grantB = await grant(b.workspaceId, { missionQuota: 3, concurrentLimit: 1 });
    await activate(b.headers, grantB.invitationToken);
    await launch(b.principal, 'b-1');
    const concurrent = await journey(b.headers);
    assert(concurrent.state === 'CONCURRENT_LIMIT_REACHED' && concurrent.account.activeMissions === 1 && concurrent.account.missionsRemaining === 2, 'one running mission at concurrentLimit 1 is CONCURRENT_LIMIT_REACHED, 2 missions left');
    constantFacts(concurrent, true);
    await sameAsGrant(concurrent, grantB.grant.grantId);
    const grantC = await grant(c.workspaceId, { missionQuota: 1, concurrentLimit: 2 });
    await activate(c.headers, grantC.invitationToken);
    const runningC = await launch(c.principal, 'c-1');
    const quota = await journey(c.headers);
    assert(quota.state === 'QUOTA_EXHAUSTED' && quota.account.quotaReason === 'MISSIONS' && quota.account.missionsRemaining === 0 && quota.account.missionsUsed === 1, 'the last admitted mission makes the allowance QUOTA_EXHAUSTED (MISSIONS)');
    assert(quota.account.status === 'ACTIVE' && quota.freeBeta.waiverApplies === true, 'an exhausted allowance keeps the account ACTIVE (waiver still applies to admitted missions)');
    constantFacts(quota, true);
    await sameAsGrant(quota, grantC.grant.grantId);
    const grantD = await grant(d.workspaceId, { missionQuota: 3, concurrentLimit: 3, maxProviderSpendMinor: 200 });
    await activate(d.headers, grantD.invitationToken);
    const runningD = await launch(d.principal, 'd-1');
    await budgets.reserve(d.principal, runningD as ID, randomUUID() as ID, 'ENGINE', 'hermes', 'qa-a2104-reserve-' + randomUUID());
    const budget = await journey(d.headers);
    assert(budget.state === 'QUOTA_EXHAUSTED' && budget.account.quotaReason === 'PROVIDER_BUDGET' && budget.account.providerBudgetRemainingMinor === 0 && budget.account.missionsRemaining === 2, 'a fully reserved provider budget is QUOTA_EXHAUSTED (PROVIDER_BUDGET) even with missions left');
    constantFacts(budget, true);
    pass('CONCURRENT_LIMIT_REACHED and QUOTA_EXHAUSTED (missions and provider budget) come from real admissions and reservations');

    // ── Group 5 · EXPIRED and REVOKED ────────────────────────────────────────────────────────────
    await db.update(betaGrants).set({ createdAt: new Date(Date.now() - 3 * 3_600_000), expiresAt: new Date(Date.now() - 1000) }).where(eq(betaGrants.id, grantC.grant.grantId));
    const expired = await journey(c.headers);
    assert(expired.state === 'EXPIRED' && expired.account.status === 'EXPIRED' && expired.freeBeta.waiverApplies === false && expired.canLaunch === false, 'a grant past its deadline is EXPIRED with no waiver');
    assert(expired.account.expiresAt === (await grantRow(grantC.grant.grantId)).expiresAt.toISOString(), 'EXPIRED shows the stored deadline');
    constantFacts(expired, true);
    const revoke = await http(base, '/v1/platform/beta-grants/' + grantB.grant.grantId + '/revoke', { headers: admin, json: { reason: 'QA A21.04 revocation for the journey' } });
    assert(revoke.status === 201, 'platform admin revokes grant B');
    const revoked = await journey(b.headers);
    assert(revoked.state === 'REVOKED' && revoked.account.status === 'REVOKED' && revoked.freeBeta.waiverApplies === false, 'a revoked grant is REVOKED with no waiver (precedes the concurrency limit)');
    constantFacts(revoked, true);
    assert(runningC.length > 0, 'fixture mission for C exists');
    pass('EXPIRED (clock) and REVOKED (operator) are stated, with no waiver and no launch');

    // ── Group 6 · NOT_CONFIGURED under the default PAYMENTS_DISABLED mode ────────────────────────
    delete process.env.QEYNOX_COMMERCE_MODE;
    const disabled = await boot();
    disabledApp = disabled.instance;
    const notConfigured = await journey(a.headers, disabled.base);
    assert(notConfigured.state === 'NOT_CONFIGURED' && notConfigured.account.status === 'ACTIVE', 'the same ACTIVE grant is NOT_CONFIGURED when the deployment is not in BETA_FREE');
    assert(notConfigured.freeBeta.enabled === false && notConfigured.freeBeta.waiverPercent === null && notConfigured.freeBeta.waiverApplies === false, 'no waiver is claimed outside BETA_FREE');
    constantFacts(notConfigured, false);
    const notConfiguredNone = await journey(memberUser.headers, disabled.base);
    assert(notConfiguredNone.state === 'NOT_CONFIGURED' && notConfiguredNone.account.status === 'NOT_ENROLLED', 'a workspace without a grant is also NOT_CONFIGURED in PAYMENTS_DISABLED');
    pass('NOT_CONFIGURED: PAYMENTS_DISABLED reports no free beta and no waiver, still no card and nothing due');

    console.log('Beta journey QA PASSED: ' + String(groups) + ' groups, ' + String(assertions) + ' assertions in ' + String(Math.round((Date.now() - startedAt) / 1000)) + 's');
    console.log('BOUNDARY: real PostgreSQL, real services and HTTP API; runtime readiness from real probes of local Hermes/Hatchet QA fixtures (no real deployment contacted); expiry by moving stored timestamps; no worker, provider or browser ran.');
  } finally {
    await runtime?.stop().catch(() => undefined);
    await app?.close().catch(() => undefined);
    await disabledApp?.close().catch(() => undefined);
    await connection?.close().catch(() => undefined);
    await qa.drop();
    console.log('QA database dropped: ' + qa.name);
  }
}

main().catch(error => {
  console.error('QA verification FAILED:', error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});

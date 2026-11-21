/**
 * MISSION A21.02 — INVITE-ONLY BETA ACCESS QA (isolated database only).
 *
 * Proves, against a real disposable PostgreSQL database, the real application services and the real
 * NestJS HTTP API (`AppModule`), that:
 *
 *   1. Without an ACTIVE grant every launch fails closed (BETA_ACCESS_REQUIRED, HTTP 403) and is
 *      recorded in the beta ledger; readiness names the blocker.
 *   2. Unauthorized callers are denied and audited: anonymous, workspace sessions on platform routes,
 *      SUPPORT / AUDITOR / OPERATIONS operators for mutations, operators granting a workspace they
 *      belong to or created (self-grant), workspace MEMBERs activating, another workspace presenting
 *      the token, and the issuing operator activating their own grant.
 *   3. Grant → activation works for an OWNER over HTTP; the token is single-use and the workspace
 *      status view is tenant-isolated.
 *   4. Parallel launches can never exceed the concurrent-mission limit nor the mission quota (exact
 *      counts under real PostgreSQL concurrency), relaunching an admitted mission does not consume
 *      quota, and the database CHECK refuses a quota overshoot even from raw SQL.
 *   5. Parallel provider-spend reservations can never exceed the grant's provider-spend cap; settled
 *      cost frees only the unspent part; an uncertain settlement stays counted; a mission never
 *      admitted cannot reserve; the database CHECK refuses an overshoot from raw SQL.
 *   6. Revocation immediately blocks new launches and new spend reservations (in-process and over
 *      HTTP, including when racing parallel launches), while settlement of earlier reservations still
 *      succeeds.
 *   7. Expired grants fail closed (launch, spend, activation of an expired invitation, status view),
 *      and a new grant materialises the expiry.
 *   8. The A21.01 payment freeze still precedes the beta gate (a priced order stays PAYMENT_REQUIRED
 *      and consumes no beta quota).
 *   9. Every grant / revoke / denial is in platform_admin_audit, and usage is in beta_grant_events.
 *
 * HONEST BOUNDARY:
 * - Missions are launched through the real OperationExecutionService (and its HTTP route). No worker,
 *   Hermes engine or provider runs: provider spend is exercised through the real BudgetService
 *   reserve/settle API that the worker calls, with QA amounts, not a live provider.
 * - Two fixture shortcuts are explicit: operation completion uses the domain transition
 *   (store.transition) instead of a worker run, and expiry is simulated by moving the stored
 *   timestamps into the past (the code under test reads the real clock).
 * - No browser runs; the Control pages are typechecked and built, not visually verified.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { and, eq, sql } from 'drizzle-orm';
import {
  QeyNoxStore, connectDatabase, runMigrations,
  betaGrantEvents, betaGrantMissions, betaGrants, identityCredentials, identityMemberships, identityUsers, identityWorkspaces,
  operations, outbox, platformAdminAssignments, platformAdminAudit,
} from '@qeynox/persistence';
import {
  BudgetService, CommerceService, ConfigurationService, InterruptionService, OperationControlService, OperationExecutionService, PlanReadService, PlanningService,
  WorkspaceBetaAccessService,
} from '@qeynox/application';
import { BetaAccessStore } from '@qeynox/persistence';
import { DomainError, type ID, type Principal } from '@qeynox/domain';
import { AppModule } from '../src/app.module';
import { DomainExceptionFilter } from '../src/transport/domain-exception.filter';
import { hashPassword } from '../src/auth/password';
import { createIsolatedQaDatabase } from './qa-isolated-database';

// ── Assertion helpers ────────────────────────────────────────────────────────────────────────────
let assertions = 0;
let groups = 0;
function assert(condition: unknown, message: string): asserts condition {
  assertions++;
  if (!condition) throw new Error('ASSERTION FAILED: ' + message);
}
function pass(message: string): void { groups++; console.log('PASS: ' + message); }
async function expectDomainError(code: string, run: () => Promise<unknown> | unknown, label: string, reason?: string): Promise<DomainError> {
  assertions++;
  try { await run(); } catch (error: unknown) {
    if (error instanceof DomainError && error.code === code && (reason === undefined || error.context?.reason === reason)) return error;
    throw new Error('EXPECTED ' + code + (reason ? '/' + reason : '') + ' for ' + label + ', got ' + (error instanceof DomainError ? error.code + ' (' + error.message + ')' : String(error)));
  }
  throw new Error('EXPECTED ' + code + ' for ' + label + ', but no error was raised');
}

async function http(base: string, path: string, init: { method?: string; json?: unknown; headers?: Record<string, string> } = {}) {
  const body = init.json === undefined ? undefined : JSON.stringify(init.json);
  const response = await fetch(base + path, {
    method: init.method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(init.headers ?? {}) },
    ...(body === undefined ? {} : { body }),
  });
  const text = await response.text();
  let parsed: unknown = text;
  try { parsed = JSON.parse(text); } catch { /* plain text */ }
  return { status: response.status, body: parsed as Record<string, unknown> };
}
const codeOf = (result: { body: Record<string, unknown> }) => (result.body as { error?: { code?: string } }).error?.code;

const platformPassword = 'beta-access-qa-passphrase';
const operators = {
  admin: { id: 'beta-qa-admin', email: 'beta-admin@example.invalid', role: 'PLATFORM_ADMIN' },
  memberAdmin: { id: 'beta-qa-member-admin', email: 'beta-member-admin@example.invalid', role: 'PLATFORM_ADMIN' },
  creatorAdmin: { id: 'beta-qa-creator-admin', email: 'beta-creator-admin@example.invalid', role: 'PLATFORM_ADMIN' },
  support: { id: 'beta-qa-support', email: 'beta-support@example.invalid', role: 'SUPPORT' },
  auditor: { id: 'beta-qa-auditor', email: 'beta-auditor@example.invalid', role: 'AUDITOR' },
  operations: { id: 'beta-qa-operations', email: 'beta-operations@example.invalid', role: 'OPERATIONS' },
} as const;

async function main(): Promise<void> {
  if (!process.env.QEYNOX_QA_DATABASE_URL) {
    console.log('BLOCKED: QEYNOX_QA_DATABASE_URL is not set. The beta-access QA suite requires an isolated PostgreSQL database; no result is claimed.');
    process.exitCode = 1;
    return;
  }
  const startedAt = Date.now();
  const qa = await createIsolatedQaDatabase();
  process.env.DATABASE_URL = qa.url;
  process.env.QEYNOX_ALLOW_REGISTRATION = 'true';
  delete process.env.QEYNOX_COMMERCE_MODE;
  let connection: ReturnType<typeof connectDatabase> | undefined;
  let app: INestApplication | undefined;
  try {
    // ── Group 0 · additive migration ─────────────────────────────────────────────────────────────
    const report = await runMigrations(qa.url);
    assert(report.applied.length === report.total && report.applied.includes('0026_beta_access.sql'), 'disposable database migrated including 0026_beta_access.sql');
    connection = connectDatabase(qa.url);
    const db = connection.db;
    const tables = await db.execute(sql`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name LIKE 'beta_%' ORDER BY 1`);
    assert(JSON.stringify(tables.rows.map(row => (row as { table_name: string }).table_name)) === JSON.stringify(['beta_grant_events', 'beta_grant_missions', 'beta_grants']), 'the three beta tables exist');
    const checks = await db.execute(sql`SELECT conname FROM pg_constraint WHERE conname IN ('beta_grants_missions_within_quota','beta_grants_spend_within_cap','beta_grants_revocation_consistent') ORDER BY 1`);
    assert(checks.rows.length === 3, 'quota, spend-cap and revocation CHECK constraints exist');
    const liveIndex = await db.execute(sql`SELECT indexdef FROM pg_indexes WHERE indexname='beta_grants_live_workspace_unique'`);
    assert(String((liveIndex.rows[0] as { indexdef?: string } | undefined)?.indexdef ?? '').startsWith('CREATE UNIQUE INDEX'), 'one live grant per workspace is enforced by a partial unique index');
    pass('migration 0026 is additive and creates beta_grants / beta_grant_missions / beta_grant_events with their backstop constraints');

    // ── Fixture · platform operators, HTTP workspaces, configuration ─────────────────────────────
    const credential = await hashPassword(platformPassword);
    for (const account of Object.values(operators)) {
      await db.insert(identityUsers).values({ id: account.id, email: account.email, locale: 'en' });
      await db.insert(identityCredentials).values({ userId: account.id, salt: credential.salt, passwordHash: credential.hash });
      await db.insert(platformAdminAssignments).values({
        id: 'beta-qa-assignment-' + account.id, userId: account.id, role: account.role, status: 'ACTIVE',
        grantedBy: 'QA_FIXTURE', grantReason: 'deterministic beta access e2e seed',
      });
    }
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
    app.useGlobalFilters(new DomainExceptionFilter());
    await app.listen(0, '127.0.0.1');
    const base = 'http://127.0.0.1:' + String((app.getHttpServer().address() as { port: number }).port);
    const platformToken = async (email: string) => {
      const response = await http(base, '/v1/platform/auth/login', { json: { email, password: platformPassword } });
      assert(response.status === 201, 'platform login for ' + email + ', got ' + String(response.status));
      return { authorization: 'Bearer ' + (response.body as { token: string }).token };
    };
    const admin = await platformToken(operators.admin.email);
    const memberAdmin = await platformToken(operators.memberAdmin.email);
    const creatorAdmin = await platformToken(operators.creatorAdmin.email);
    const support = await platformToken(operators.support.email);
    const auditor = await platformToken(operators.auditor.email);
    const operationsOperator = await platformToken(operators.operations.email);

    const register = async (label: string) => {
      const response = await http(base, '/v1/auth/register', {
        json: { email: 'qa-a2102-' + label + '-' + randomUUID().slice(0, 8) + '@example.invalid', password: 'qa-a2102-strong-password-' + label, workspaceName: 'QA A21.02 ' + label },
      });
      assert(response.status === 201, 'registered ' + label + ' over HTTP, got ' + String(response.status));
      const auth = response.body as unknown as { token: string; userId: string; workspaceId: string };
      return {
        userId: auth.userId, workspaceId: auth.workspaceId,
        principal: { userId: auth.userId as ID, workspaceId: auth.workspaceId as ID, roles: ['OWNER'] } as Principal,
        headers: { authorization: 'Bearer ' + auth.token, 'x-qeynox-workspace': auth.workspaceId },
      };
    };
    const ownerA = await register('owner-a');
    const ownerB = await register('owner-b');
    const ownerC = await register('owner-c');
    const ownerD = await register('owner-d');
    const memberUser = await register('member-a');
    // memberUser also becomes an ACTIVE MEMBER of workspace A; the platform operator memberAdmin holds
    // a (REVOKED) membership row in workspace A: any membership row, whatever its status, forbids a grant.
    await db.insert(identityMemberships).values([
      { id: randomUUID(), userId: memberUser.userId, workspaceId: ownerA.workspaceId, role: 'MEMBER', status: 'ACTIVE', joinedAt: new Date() },
      { id: randomUUID(), userId: operators.memberAdmin.id, workspaceId: ownerA.workspaceId, role: 'ADMIN', status: 'REVOKED' },
    ]);
    const memberA = { principal: { userId: memberUser.userId as ID, workspaceId: ownerA.workspaceId as ID, roles: ['MEMBER'] } as Principal, headers: { authorization: memberUser.headers.authorization, 'x-qeynox-workspace': ownerA.workspaceId } };
    // A workspace CREATED by creatorAdmin (no membership row at all) — creation alone forbids a grant.
    const creatorWorkspace = randomUUID();
    await db.insert(identityWorkspaces).values({ id: creatorWorkspace, name: 'QA A21.02 creator workspace', createdBy: operators.creatorAdmin.id });

    const store = new QeyNoxStore(db);
    process.env.QEYNOX_OPERATOR_USER_IDS = [ownerA, ownerB, ownerC, ownerD].map(owner => owner.userId).join(',');
    const configuration = new ConfigurationService(store);
    const budgetEntry = { domain: 'BUDGET_POLICY', policyId: 'default', version: 1, status: 'ACTIVE', currency: 'USD', maxMoneyMinor: 100_000, maxAgentCalls: 50, maxToolCalls: 50, maxDurationSeconds: 3600, maxConcurrent: 10, unitMaxMinor: { hermes: 200 } };
    await configuration.apply(ownerA.principal, {
      idempotencyKey: 'qa-a2102-config-a',
      entries: [
        { domain: 'BUSINESS_CAPABILITY', slot: 1, version: 1, status: 'ACTIVE', name: 'QA A21.02 Capability', purpose: 'QA-only capability for beta access verification', scope: ['QA A21.02 scope'], allowedTools: [], privacyScopes: [], inputSchemaVersion: 1, outputSchemaVersion: 1, maximumSteps: 5, maximumToolCalls: 2 },
        { domain: 'RAAS_OFFER', offerId: 'qa-a2102-free-offer', version: 1, status: 'ACTIVE', label: 'QA A21.02 Free Offer', capabilityIds: ['capability-slot-1-v1'], deliverableSchemaVersion: 1, scope: ['QA A21.02 scope'], exclusions: [], regions: ['GLOBAL'], locales: ['en'], termsVersion: 'qa-a2102-terms', currency: 'USD', amountMinor: 0, taxPolicy: 'CONFIGURED', isExplicitlyFree: true },
        { domain: 'RAAS_OFFER', offerId: 'qa-a2102-paid-offer', version: 1, status: 'ACTIVE', label: 'QA A21.02 Paid Offer', capabilityIds: ['capability-slot-1-v1'], deliverableSchemaVersion: 1, scope: ['QA A21.02 scope'], exclusions: [], regions: ['GLOBAL'], locales: ['en'], termsVersion: 'qa-a2102-terms', currency: 'USD', amountMinor: 2500, taxPolicy: 'CONFIGURED', isExplicitlyFree: false },
        budgetEntry,
      ],
    } as never);
    for (const owner of [ownerB, ownerC, ownerD]) {
      await configuration.apply(owner.principal, { idempotencyKey: 'qa-a2102-config-' + owner.workspaceId.slice(0, 8), entries: [budgetEntry] } as never);
    }

    const planning = new PlanningService(store);
    const commerce = new CommerceService(store);
    const execution = new OperationExecutionService(store);
    const budgets = new BudgetService(store);
    const planRead = new PlanReadService(store);
    const betaStore = new BetaAccessStore(db);
    const readyOp = async (owner: Principal, label: string, offerId = 'qa-a2102-free-offer') => {
      const operation = await store.createOperation(owner, 'QA A21.02 ' + label, 'QA A21.02 beta access objective ' + label, []);
      const plan = await planning.create(owner, operation.id, operation.version, [{
        title: 'QA A21.02 step', description: 'QA A21.02 step description', capabilityId: 'capability-slot-1-v1' as ID, dependsOnIndices: [], intent: 'RESEARCH',
      }]);
      const quote = await commerce.quote(owner, operation.id, offerId, plan.revision.id) as { id: string };
      await commerce.accept(owner, quote.id as ID, 'qa-a2102-accept-' + label + '-' + randomUUID().slice(0, 8));
      return store.getOperation(owner, operation.id);
    };
    const start = async (owner: Principal, operationId: ID) => {
      const current = await store.getOperation(owner, operationId);
      return execution.start(owner, operationId, current.version, 'qa-a2102-start-' + randomUUID());
    };
    const grantRow = async (grantId: string) => (await db.select().from(betaGrants).where(eq(betaGrants.id, grantId)))[0]!;
    const eventsOf = async (workspaceId: string, kind?: string) => db.select().from(betaGrantEvents)
      .where(kind ? and(eq(betaGrantEvents.workspaceId, workspaceId), eq(betaGrantEvents.kind, kind as never)) : eq(betaGrantEvents.workspaceId, workspaceId));
    const deniedAudits = async () => (await db.select({ n: sql<number>`count(*)::int` }).from(platformAdminAudit).where(eq(platformAdminAudit.outcome, 'DENIED')))[0]!.n;
    const grantsCount = async () => (await db.select({ n: sql<number>`count(*)::int` }).from(betaGrants))[0]!.n;
    const expiresIn = (ms: number) => new Date(Date.now() + ms).toISOString();
    const DAY = 24 * 60 * 60 * 1000;
    const grantBody = (workspaceId: string, extra: Record<string, unknown> = {}) => ({
      workspaceId, expiresAt: expiresIn(30 * DAY), missionQuota: 3, concurrentLimit: 2, maxProviderSpendMinor: 500, currency: 'USD',
      reason: 'QA A21.02 invite-only beta grant for verification', ...extra,
    });
    pass('fixture: six platform operators, five HTTP workspaces, a workspace member, a creator-only workspace and real configuration');

    // ── Group 1 · fail closed without a grant ────────────────────────────────────────────────────
    const noGrantOp = await readyOp(ownerA.principal, 'no-grant');
    await expectDomainError('BETA_ACCESS_REQUIRED', () => start(ownerA.principal, noGrantOp.id), 'launch without any grant', 'NO_GRANT');
    const httpNoGrant = await http(base, '/v1/operations/' + noGrantOp.id + '/start', { headers: ownerA.headers, json: { expectedVersion: noGrantOp.version, idempotencyKey: 'qa-a2102-http-nogrant-1' } });
    assert(httpNoGrant.status === 403 && codeOf(httpNoGrant) === 'BETA_ACCESS_REQUIRED', 'HTTP launch without a grant is 403 BETA_ACCESS_REQUIRED, got ' + String(httpNoGrant.status) + ' ' + JSON.stringify(httpNoGrant.body));
    const afterNoGrant = await store.getOperation(ownerA.principal, noGrantOp.id);
    assert(afterNoGrant.status === 'READY' && afterNoGrant.version === noGrantOp.version, 'a refused launch leaves the operation READY and unversioned');
    assert((await db.select().from(outbox).where(eq(outbox.operationId, noGrantOp.id))).length === 0, 'a refused launch dispatches nothing (no outbox row)');
    const noGrantDenials = await eventsOf(ownerA.workspaceId, 'LAUNCH_DENIED');
    assert(noGrantDenials.length === 2 && noGrantDenials.every(event => event.grantId === null && event.reason === 'NO_GRANT' && event.operationId === noGrantOp.id), 'both refusals are in the beta ledger with reason NO_GRANT');
    const readiness = await planRead.readiness(ownerA.principal, noGrantOp.id);
    assert(readiness.blockers.some(blocker => blocker.code === 'BETA_ACCESS_REQUIRED' && blocker.category === 'AUTHORIZATION') && !readiness.canStart, 'readiness names BETA_ACCESS_REQUIRED and does not offer a launch');
    const statusNone = await http(base, '/v1/workspaces/current/beta-access', { headers: ownerA.headers });
    assert(statusNone.status === 200 && statusNone.body.eligible === false && statusNone.body.blocker === 'NO_GRANT' && statusNone.body.grant === null, 'workspace status reports NO_GRANT');
    pass('without a grant every launch fails closed (in-process and HTTP 403), dispatches nothing, is ledgered and is shown as a readiness blocker');

    // ── Group 2 · unauthorized grant attempts are denied and audited ─────────────────────────────
    const deniedBefore = await deniedAudits();
    const anonymous = await http(base, '/v1/platform/beta-grants', { json: grantBody(ownerA.workspaceId) });
    assert(anonymous.status === 401 || anonymous.status === 403, 'anonymous grant attempt is refused, got ' + String(anonymous.status));
    const anonymousList = await http(base, '/v1/platform/beta-grants');
    assert(anonymousList.status === 401 || anonymousList.status === 403, 'anonymous listing is refused');
    const workspaceSession = await http(base, '/v1/platform/beta-grants', { headers: ownerA.headers, json: grantBody(ownerA.workspaceId) });
    assert(workspaceSession.status === 401 || workspaceSession.status === 403, 'a workspace OWNER session cannot reach the platform grant route (no self-grant through the customer session), got ' + String(workspaceSession.status));
    const memberSession = await http(base, '/v1/platform/beta-grants', { headers: memberA.headers, json: grantBody(ownerA.workspaceId) });
    assert(memberSession.status === 401 || memberSession.status === 403, 'a workspace MEMBER session cannot reach the platform grant route');
    for (const [label, headers] of [['SUPPORT', support], ['AUDITOR', auditor], ['OPERATIONS', operationsOperator]] as const) {
      const attempt = await http(base, '/v1/platform/beta-grants', { headers, json: grantBody(ownerA.workspaceId) });
      assert(attempt.status === 403 && codeOf(attempt) === 'DENIED', label + ' operator cannot grant beta access, got ' + String(attempt.status));
    }
    for (const [label, headers] of [['AUDITOR', auditor], ['OPERATIONS', operationsOperator]] as const) {
      const listing = await http(base, '/v1/platform/beta-grants', { headers });
      assert(listing.status === 403, label + ' operator cannot read beta grants');
    }
    const supportList = await http(base, '/v1/platform/beta-grants', { headers: support });
    assert(supportList.status === 200 && Array.isArray(supportList.body.items), 'SUPPORT can read beta grants');
    const selfGrant = await http(base, '/v1/platform/beta-grants', { headers: memberAdmin, json: grantBody(ownerA.workspaceId) });
    assert(selfGrant.status === 403 && codeOf(selfGrant) === 'DENIED', 'a PLATFORM_ADMIN holding a membership row in the workspace cannot grant it (self-grant), got ' + String(selfGrant.status));
    const creatorGrant = await http(base, '/v1/platform/beta-grants', { headers: creatorAdmin, json: grantBody(creatorWorkspace) });
    assert(creatorGrant.status === 403 && codeOf(creatorGrant) === 'DENIED', 'a PLATFORM_ADMIN who created the workspace cannot grant it (self-grant)');
    const pastExpiry = await http(base, '/v1/platform/beta-grants', { headers: admin, json: grantBody(ownerA.workspaceId, { expiresAt: new Date(Date.now() - 60_000).toISOString() }) });
    assert(pastExpiry.status === 400 && codeOf(pastExpiry) === 'INVALID_INPUT', 'a grant that is already expired is refused');
    const zeroQuota = await http(base, '/v1/platform/beta-grants', { headers: admin, json: grantBody(ownerA.workspaceId, { missionQuota: 0 }) });
    assert(zeroQuota.status === 400, 'a zero mission quota is refused');
    const shortReason = await http(base, '/v1/platform/beta-grants', { headers: admin, json: grantBody(ownerA.workspaceId, { reason: 'short' }) });
    assert(shortReason.status === 400, 'a grant without a written justification is refused');
    const unknownWorkspace = await http(base, '/v1/platform/beta-grants', { headers: admin, json: grantBody('workspace-that-does-not-exist') });
    assert(unknownWorkspace.status === 404, 'a grant for an unknown workspace is refused');
    assert(await grantsCount() === 0, 'no grant row exists after every unauthorized or invalid attempt');
    const selfAudits = await db.select().from(platformAdminAudit).where(and(eq(platformAdminAudit.action, 'GRANT_BETA_ACCESS'), eq(platformAdminAudit.reason, 'SELF_GRANT_FORBIDDEN')));
    assert(selfAudits.length === 2 && selfAudits.every(row => row.outcome === 'DENIED'), 'both self-grant attempts are audited as DENIED/SELF_GRANT_FORBIDDEN');
    const deniedAfter = await deniedAudits();
    assert(deniedAfter - deniedBefore >= 12, 'every refusal produced a DENIED platform audit row (got ' + String(deniedAfter - deniedBefore) + ')');
    pass('anonymous, workspace sessions, SUPPORT/AUDITOR/OPERATIONS operators, self-grants (membership or creator) and invalid grants are all refused and audited; no grant row is written');

    // ── Group 3 · grant, activation, single-use token, isolation ────────────────────────────────
    const grantedA = await http(base, '/v1/platform/beta-grants', { headers: admin, json: grantBody(ownerA.workspaceId) });
    assert(grantedA.status === 201, 'PLATFORM_ADMIN grants beta access to workspace A, got ' + String(grantedA.status) + ' ' + JSON.stringify(grantedA.body));
    const createdA = grantedA.body as unknown as { grant: { grantId: string; status: string }; invitationToken: string; delivery: { email: string } };
    assert(createdA.grant.status === 'INVITED' && /^[A-Za-z0-9_-]{43}$/.test(createdA.invitationToken) && createdA.delivery.email === 'BLOCKED', 'the grant starts INVITED with a one-time token and honest manual delivery');
    const storedA = await grantRow(createdA.grant.grantId);
    assert(storedA.invitationTokenHash !== null && storedA.invitationTokenHash !== createdA.invitationToken && storedA.invitationTokenHash.length === 64, 'only the SHA-256 digest of the token is stored');
    const duplicate = await http(base, '/v1/platform/beta-grants', { headers: admin, json: grantBody(ownerA.workspaceId) });
    assert(duplicate.status === 409, 'a second live grant for the same workspace is a CONFLICT');
    const invitedOp = await readyOp(ownerA.principal, 'invited');
    await expectDomainError('BETA_ACCESS_REQUIRED', () => start(ownerA.principal, invitedOp.id), 'launch while the grant is only INVITED', 'GRANT_NOT_ACTIVATED');
    const memberActivation = await http(base, '/v1/workspaces/current/beta-access/activate', { headers: memberA.headers, json: { token: createdA.invitationToken } });
    assert(memberActivation.status === 403, 'a workspace MEMBER cannot activate, got ' + String(memberActivation.status));
    const crossTenant = await http(base, '/v1/workspaces/current/beta-access/activate', { headers: ownerB.headers, json: { token: createdA.invitationToken } });
    assert(crossTenant.status === 404, 'another workspace presenting the token learns nothing (404), got ' + String(crossTenant.status));
    const issuerActivation = new WorkspaceBetaAccessService(betaStore);
    await expectDomainError('DENIED', () => issuerActivation.activate({ userId: operators.admin.id as ID, workspaceId: ownerA.workspaceId as ID, roles: ['OWNER'] }, createdA.invitationToken), 'the issuing operator activating their own grant');
    assert((await grantRow(createdA.grant.grantId)).status === 'INVITED', 'every refused activation leaves the grant INVITED');
    const activationDenials = await eventsOf(ownerA.workspaceId, 'ACTIVATION_DENIED');
    assert(['ROLE_REQUIRED', 'WRONG_WORKSPACE', 'SELF_ACTIVATION'].every(reason => activationDenials.some(event => event.reason === reason)), 'refused activations are ledgered on the grant\'s own workspace');
    const activated = await http(base, '/v1/workspaces/current/beta-access/activate', { headers: ownerA.headers, json: { token: createdA.invitationToken } });
    assert(activated.status === 201 && activated.body.eligible === true && (activated.body.grant as { status: string }).status === 'ACTIVE', 'the workspace OWNER activates the grant, got ' + String(activated.status) + ' ' + JSON.stringify(activated.body));
    const replay = await http(base, '/v1/workspaces/current/beta-access/activate', { headers: ownerA.headers, json: { token: createdA.invitationToken } });
    assert(replay.status === 404, 'the invitation token is single-use');
    const memberStatus = await http(base, '/v1/workspaces/current/beta-access', { headers: memberA.headers });
    assert(memberStatus.status === 200 && (memberStatus.body.grant as { status: string }).status === 'ACTIVE', 'any ACTIVE member can read the workspace beta status');
    assert(!('grantedBy' in (memberStatus.body.grant as object)) && !('grantReason' in (memberStatus.body.grant as object)), 'the customer view does not expose the operator identity or justification');
    const statusB = await http(base, '/v1/workspaces/current/beta-access', { headers: ownerB.headers });
    assert(statusB.status === 200 && statusB.body.grant === null && statusB.body.workspaceId === ownerB.workspaceId, 'workspace B sees only its own (absent) grant');
    const spoof = await http(base, '/v1/workspaces/current/beta-access', { headers: { authorization: ownerB.headers.authorization, 'x-qeynox-workspace': ownerA.workspaceId } });
    assert(spoof.status === 403, 'workspace B cannot read workspace A\'s beta status by naming it');
    const grantAudit = await db.select().from(platformAdminAudit).where(and(eq(platformAdminAudit.action, 'GRANT_BETA_ACCESS'), eq(platformAdminAudit.outcome, 'SUCCESS')));
    assert(grantAudit.length === 1 && grantAudit[0]!.actorUserId === operators.admin.id && grantAudit[0]!.targetId === createdA.grant.grantId, 'the grant committed with a SUCCESS platform audit row');
    pass('grant → activation by OWNER works; MEMBER, cross-tenant and issuer activations are refused; the token is single-use; status is tenant-isolated');

    // ── Group 4 · parallel launches cannot exceed concurrency or quota ──────────────────────────
    const grantA = createdA.grant.grantId;
    const batch = await Promise.all(Array.from({ length: 6 }, (_v, index) => readyOp(ownerA.principal, 'parallel-' + index)));
    const round1 = await Promise.allSettled(batch.map(op => start(ownerA.principal, op.id)));
    const round1Ok = round1.filter(result => result.status === 'fulfilled').length;
    const round1Refusals = round1.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    assert(round1Ok === 2, 'exactly concurrentLimit=2 of 6 parallel launches succeed, got ' + String(round1Ok));
    assert(round1Refusals.every(result => result.reason instanceof DomainError && result.reason.code === 'BETA_LIMIT_REACHED' && result.reason.context?.reason === 'CONCURRENT_LIMIT_REACHED'), 'the 4 others are refused with CONCURRENT_LIMIT_REACHED');
    const runningA = await db.select().from(operations).where(and(eq(operations.workspaceId, ownerA.workspaceId), eq(operations.status, 'RUNNING')));
    assert(runningA.length === 2 && (await grantRow(grantA)).missionsUsed === 2, 'two missions RUNNING and missions_used=2');
    // Complete one running mission (domain transition), freeing one slot: quota allows exactly one more.
    const firstRunning = runningA[0]!;
    await store.transition(ownerA.principal, firstRunning.id as ID, 'COMPLETED', firstRunning.version);
    const remaining = batch.filter(op => !runningA.some(row => row.id === op.id));
    const round2 = await Promise.allSettled(remaining.map(op => start(ownerA.principal, op.id)));
    assert(round2.filter(result => result.status === 'fulfilled').length === 1, 'after one completion exactly one more parallel launch succeeds');
    assert((await grantRow(grantA)).missionsUsed === 3, 'missions_used reached the quota of 3 and not beyond');
    for (const row of await db.select().from(operations).where(and(eq(operations.workspaceId, ownerA.workspaceId), eq(operations.status, 'RUNNING')))) {
      await store.transition(ownerA.principal, row.id as ID, 'COMPLETED', row.version);
    }
    const stillReady = await db.select().from(operations).where(and(eq(operations.workspaceId, ownerA.workspaceId), eq(operations.status, 'READY')));
    const round3 = await Promise.allSettled(stillReady.map(row => start(ownerA.principal, row.id as ID)));
    assert(round3.length >= 3 && round3.every(result => result.status === 'rejected' && result.reason instanceof DomainError && result.reason.context?.reason === 'MISSION_QUOTA_REACHED'), 'with free slots but an exhausted quota every parallel launch is refused (MISSION_QUOTA_REACHED)');
    assert((await grantRow(grantA)).missionsUsed === 3, 'missions_used stays exactly at the quota');
    const admittedA = await db.select().from(betaGrantMissions).where(eq(betaGrantMissions.grantId, grantA));
    assert(admittedA.length === 3 && new Set(admittedA.map(row => row.operationId)).size === 3, 'exactly three distinct missions are admitted under the grant');
    // Relaunch of an already-admitted mission (FAILED → start) is allowed and does not consume quota.
    const relaunch = admittedA[0]!;
    const relaunchRow = (await db.select().from(operations).where(eq(operations.id, relaunch.operationId)))[0]!;
    await db.update(operations).set({ status: 'FAILED', payload: { ...relaunchRow.payload, status: 'FAILED' } }).where(eq(operations.id, relaunch.operationId));
    await start(ownerA.principal, relaunch.operationId as ID);
    assert((await grantRow(grantA)).missionsUsed === 3 && (await eventsOf(ownerA.workspaceId, 'MISSION_RESUMED')).length === 1, 'relaunching an admitted mission is MISSION_RESUMED without consuming quota');
    let quotaBackstop = false;
    try { await db.update(betaGrants).set({ missionsUsed: 4 }).where(eq(betaGrants.id, grantA)); } catch { quotaBackstop = true; }
    assert(quotaBackstop && (await grantRow(grantA)).missionsUsed === 3, 'the database CHECK refuses missions_used above the quota even from raw SQL');
    pass('parallel launches never exceed concurrentLimit (2/6) nor the mission quota (3), relaunch does not consume quota, and the DB CHECK backstops the quota');

    // ── Group 5 · parallel provider-spend reservations cannot exceed the cap ────────────────────
    const spendOps = await db.select().from(operations).where(and(eq(operations.workspaceId, ownerA.workspaceId), eq(operations.status, 'RUNNING')));
    assert(spendOps.length === 1, 'one admitted mission is RUNNING for spend tests');
    const spendOp = spendOps[0]!.id as ID;
    const reserve = (operationId: ID) => budgets.reserve(ownerA.principal, operationId, randomUUID() as ID, 'ENGINE', 'hermes', 'qa-a2102-reserve-' + randomUUID());
    const reserves = await Promise.allSettled(Array.from({ length: 6 }, () => reserve(spendOp)));
    const reserved = reserves.filter((result): result is PromiseFulfilledResult<{ reservationId: string; maximumCostMinor: number }> => result.status === 'fulfilled');
    assert(reserved.length === 2, 'exactly 2 of 6 parallel 200-unit reservations fit a 500 cap, got ' + String(reserved.length));
    assert(reserves.filter(result => result.status === 'rejected').every(result => (result as PromiseRejectedResult).reason instanceof DomainError && ((result as PromiseRejectedResult).reason as DomainError).context?.reason === 'PROVIDER_SPEND_CAP_REACHED'), 'the others are refused with PROVIDER_SPEND_CAP_REACHED');
    let stateA = await grantRow(grantA);
    assert(stateA.reservedMinor === 400 && stateA.spentMinor === 0, 'grant reserved_minor=400 spent=0');
    assert((await eventsOf(ownerA.workspaceId, 'SPEND_DENIED')).length === 4 && (await eventsOf(ownerA.workspaceId, 'SPEND_RESERVED')).length === 2, 'reservations and refusals are ledgered');
    await budgets.settle(ownerA.principal, reserved[0]!.value.reservationId as ID, { costMinor: 150, origin: 'PROVIDER_REPORTED' });
    stateA = await grantRow(grantA);
    assert(stateA.reservedMinor === 200 && stateA.spentMinor === 150, 'settling at 150 frees only the unspent part (reserved 200, spent 150)');
    await expectDomainError('BETA_LIMIT_REACHED', () => reserve(spendOp), 'reservation beyond the remaining 150 headroom', 'PROVIDER_SPEND_CAP_REACHED');
    await budgets.settle(ownerA.principal, reserved[1]!.value.reservationId as ID, { origin: 'UNKNOWN' });
    stateA = await grantRow(grantA);
    assert(stateA.reservedMinor === 200 && stateA.spentMinor === 150, 'an UNKNOWN settlement keeps its amount reserved against the cap');
    await expectDomainError('BETA_LIMIT_REACHED', () => reserve(spendOp), 'reservation while an uncertain cost is still counted', 'PROVIDER_SPEND_CAP_REACHED');
    const neverAdmitted = stillReady.find(row => !admittedA.some(admitted => admitted.operationId === row.id))!;
    await budgets.ensureBudget(ownerA.principal, neverAdmitted.id as ID);
    await expectDomainError('BETA_ACCESS_REQUIRED', () => reserve(neverAdmitted.id as ID), 'reservation for a mission never admitted under a grant', 'MISSION_NOT_ADMITTED');
    let spendBackstop = false;
    try { await db.update(betaGrants).set({ spentMinor: 301 }).where(eq(betaGrants.id, grantA)); } catch { spendBackstop = true; }
    assert(spendBackstop, 'the database CHECK refuses reserved+spent above the cap even from raw SQL');
    stateA = await grantRow(grantA);
    assert(stateA.reservedMinor + stateA.spentMinor <= stateA.maxProviderSpendMinor, 'reserved + spent never exceeded the provider-spend cap');
    pass('parallel spend reservations never exceed the cap (2/6 at 200 under 500), settlement frees only unspent money, uncertain cost stays counted, unadmitted missions cannot spend, DB CHECK backstops');

    // ── Group 6 · revocation immediately blocks launches and spend ──────────────────────────────
    const grantedB = await http(base, '/v1/platform/beta-grants', { headers: admin, json: grantBody(ownerB.workspaceId, { missionQuota: 20, concurrentLimit: 10, maxProviderSpendMinor: 10_000 }) });
    assert(grantedB.status === 201, 'grant for workspace B');
    const createdB = grantedB.body as unknown as { grant: { grantId: string }; invitationToken: string };
    assert((await http(base, '/v1/workspaces/current/beta-access/activate', { headers: ownerB.headers, json: { token: createdB.invitationToken } })).status === 201, 'workspace B activated');
    const runningB = await readyOp(ownerB.principal, 'b-running');
    const startedB = await start(ownerB.principal, runningB.id) as { attemptId: ID };
    const preRevokeReservation = await budgets.reserve(ownerB.principal, runningB.id, randomUUID() as ID, 'ENGINE', 'hermes', 'qa-a2102-b-pre-' + randomUUID());
    const supportRevoke = await http(base, '/v1/platform/beta-grants/' + createdB.grant.grantId + '/revoke', { headers: support, json: { reason: 'QA A21.02 support must not revoke' } });
    assert(supportRevoke.status === 403, 'SUPPORT cannot revoke');
    const ownerRevoke = await http(base, '/v1/platform/beta-grants/' + createdB.grant.grantId + '/revoke', { headers: ownerB.headers, json: { reason: 'QA A21.02 owner must not revoke via platform' } });
    assert(ownerRevoke.status === 401 || ownerRevoke.status === 403, 'a workspace session cannot revoke');
    const raceOps = await Promise.all(Array.from({ length: 4 }, (_v, index) => readyOp(ownerB.principal, 'b-race-' + index)));
    const [revokeResult, ...raceResults] = await Promise.allSettled([
      http(base, '/v1/platform/beta-grants/' + createdB.grant.grantId + '/revoke', { headers: admin, json: { reason: 'QA A21.02 revocation under concurrent launches' } }),
      ...raceOps.map(op => start(ownerB.principal, op.id)),
    ]);
    assert(revokeResult!.status === 'fulfilled' && revokeResult.value.status === 201 && (revokeResult.value.body as { status: string }).status === 'REVOKED', 'PLATFORM_ADMIN revokes the grant');
    const revokedB = await grantRow(createdB.grant.grantId);
    const admittedB = await db.select().from(betaGrantEvents).where(and(eq(betaGrantEvents.grantId, revokedB.id), eq(betaGrantEvents.kind, 'MISSION_ADMITTED')));
    assert(admittedB.every(event => event.occurredAt.getTime() <= revokedB.revokedAt!.getTime()), 'no mission was admitted after the revocation committed (racing launches serialise on the grant row)');
    assert(raceResults.filter(result => result.status === 'rejected').every(result => ((result as PromiseRejectedResult).reason as DomainError).context?.reason === 'GRANT_REVOKED'), 'racing launches that lost the race are refused with GRANT_REVOKED');
    const afterRevoke = await readyOp(ownerB.principal, 'b-after-revoke');
    await expectDomainError('BETA_ACCESS_REQUIRED', () => start(ownerB.principal, afterRevoke.id), 'launch immediately after revocation', 'GRANT_REVOKED');
    const httpAfterRevoke = await http(base, '/v1/operations/' + afterRevoke.id + '/start', { headers: ownerB.headers, json: { expectedVersion: afterRevoke.version, idempotencyKey: 'qa-a2102-http-revoked-1' } });
    assert(httpAfterRevoke.status === 403 && codeOf(httpAfterRevoke) === 'BETA_ACCESS_REQUIRED', 'HTTP launch immediately after revocation is 403');
    await expectDomainError('BETA_ACCESS_REQUIRED', () => budgets.reserve(ownerB.principal, runningB.id, randomUUID() as ID, 'ENGINE', 'hermes', 'qa-a2102-b-post-' + randomUUID()), 'new spend reservation for a running mission after revocation', 'GRANT_REVOKED');
    await budgets.settle(ownerB.principal, preRevokeReservation.reservationId as ID, { costMinor: 120, origin: 'PROVIDER_REPORTED' });
    const settledB = await grantRow(createdB.grant.grantId);
    assert(settledB.spentMinor === 120 && settledB.reservedMinor === 0, 'a reservation made before the revocation still settles truthfully');
    // Retry and redo re-launch work: they pass the same gate and are refused after revocation too.
    const failedB = (await db.select().from(operations).where(eq(operations.id, runningB.id)))[0]!;
    await db.update(operations).set({ status: 'FAILED', payload: { ...failedB.payload, status: 'FAILED' } }).where(eq(operations.id, runningB.id));
    const usedBeforeRelaunch = (await grantRow(createdB.grant.grantId)).missionsUsed;
    await expectDomainError('BETA_ACCESS_REQUIRED', () => new InterruptionService(store).retry(ownerB.principal, runningB.id, failedB.version, 'qa-a2102-retry-' + randomUUID()), 'retry after revocation', 'GRANT_REVOKED');
    await expectDomainError('BETA_ACCESS_REQUIRED', () => new OperationControlService(store).requestRedo(ownerB.principal, runningB.id, startedB.attemptId, failedB.version, 'qa-a2102-redo-' + randomUUID()), 'redo after revocation', 'GRANT_REVOKED');
    assert((await store.getOperation(ownerB.principal, runningB.id)).status === 'FAILED' && (await grantRow(createdB.grant.grantId)).missionsUsed === usedBeforeRelaunch, 'refused retry/redo leave the operation FAILED and consume nothing');
    const relaunchDenials = (await eventsOf(ownerB.workspaceId, 'LAUNCH_DENIED')).filter(event => event.operationId === runningB.id);
    assert(relaunchDenials.length === 2 && relaunchDenials.every(event => event.reason === 'GRANT_REVOKED'), 'refused retry and redo are both ledgered as LAUNCH_DENIED/GRANT_REVOKED');
    const revokeAgain = await http(base, '/v1/platform/beta-grants/' + createdB.grant.grantId + '/revoke', { headers: admin, json: { reason: 'QA A21.02 second revocation attempt' } });
    assert(revokeAgain.status === 409, 'revoking twice is a CONFLICT');
    const revokeAudit = await db.select().from(platformAdminAudit).where(and(eq(platformAdminAudit.action, 'REVOKE_BETA_ACCESS'), eq(platformAdminAudit.outcome, 'SUCCESS')));
    assert(revokeAudit.length === 1 && revokeAudit[0]!.targetId === createdB.grant.grantId, 'the revocation committed with a SUCCESS platform audit row');
    const statusRevoked = await http(base, '/v1/workspaces/current/beta-access', { headers: ownerB.headers });
    assert(statusRevoked.body.eligible === false && statusRevoked.body.blocker === 'GRANT_REVOKED', 'workspace B status reports GRANT_REVOKED');
    pass('revocation immediately blocks new launches (start in-process, HTTP, racing launches, retry and redo) and new spend, while earlier reservations still settle; revocation is audited and not repeatable');

    // ── Group 7 · expired grants fail closed ────────────────────────────────────────────────────
    const grantedC = await http(base, '/v1/platform/beta-grants', { headers: admin, json: grantBody(ownerC.workspaceId, { expiresAt: expiresIn(60 * 60 * 1000), missionQuota: 5, concurrentLimit: 5, maxProviderSpendMinor: 5000 }) });
    const createdC = grantedC.body as unknown as { grant: { grantId: string }; invitationToken: string };
    assert(grantedC.status === 201 && (await http(base, '/v1/workspaces/current/beta-access/activate', { headers: ownerC.headers, json: { token: createdC.invitationToken } })).status === 201, 'grant for workspace C activated');
    const runningC = await readyOp(ownerC.principal, 'c-running');
    await start(ownerC.principal, runningC.id);
    // Move the deadline into the past while the stored status stays ACTIVE (nothing materialised it).
    await db.update(betaGrants).set({ createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000), expiresAt: new Date(Date.now() - 1000) }).where(eq(betaGrants.id, createdC.grant.grantId));
    assert((await grantRow(createdC.grant.grantId)).status === 'ACTIVE', 'fixture: stored status is still ACTIVE after the deadline');
    const expiredOp = await readyOp(ownerC.principal, 'c-expired');
    await expectDomainError('BETA_ACCESS_REQUIRED', () => start(ownerC.principal, expiredOp.id), 'launch after the deadline', 'GRANT_EXPIRED');
    await expectDomainError('BETA_ACCESS_REQUIRED', () => budgets.reserve(ownerC.principal, runningC.id, randomUUID() as ID, 'ENGINE', 'hermes', 'qa-a2102-c-' + randomUUID()), 'spend after the deadline', 'GRANT_EXPIRED');
    const statusExpired = await http(base, '/v1/workspaces/current/beta-access', { headers: ownerC.headers });
    assert(statusExpired.body.eligible === false && statusExpired.body.blocker === 'GRANT_EXPIRED' && (statusExpired.body.grant as { status: string }).status === 'EXPIRED', 'workspace status reports EXPIRED from the clock, not the stored status');
    const expiredList = await http(base, '/v1/platform/beta-grants?status=EXPIRED', { headers: support });
    assert((expiredList.body.items as { grantId: string }[]).some(item => item.grantId === createdC.grant.grantId), 'the operator list filters on the effective EXPIRED status');
    const expiredReadiness = await planRead.readiness(ownerC.principal, expiredOp.id);
    assert(expiredReadiness.blockers.some(blocker => blocker.code === 'BETA_ACCESS_REQUIRED' && blocker.detail.includes('GRANT_EXPIRED')), 'readiness names the expired grant');
    const renewed = await http(base, '/v1/platform/beta-grants', { headers: admin, json: grantBody(ownerC.workspaceId) });
    assert(renewed.status === 201, 'a new grant can be issued once the previous one expired');
    assert((await grantRow(createdC.grant.grantId)).status === 'EXPIRED' && (await eventsOf(ownerC.workspaceId, 'EXPIRED')).length === 1, 'issuing the new grant materialised the expiry with an EXPIRED event');
    // An invitation that was never activated in time fails closed too.
    const grantedD = await http(base, '/v1/platform/beta-grants', { headers: admin, json: grantBody(ownerD.workspaceId) });
    const createdD = grantedD.body as unknown as { grant: { grantId: string }; invitationToken: string };
    await db.update(betaGrants).set({ invitationExpiresAt: new Date(Date.now() - 1000) }).where(eq(betaGrants.id, createdD.grant.grantId));
    const lateActivation = await http(base, '/v1/workspaces/current/beta-access/activate', { headers: ownerD.headers, json: { token: createdD.invitationToken } });
    assert(lateActivation.status === 409 && (await grantRow(createdD.grant.grantId)).status === 'INVITED', 'an expired invitation cannot be activated, got ' + String(lateActivation.status));
    const lateDOp = await readyOp(ownerD.principal, 'd-late');
    await expectDomainError('BETA_ACCESS_REQUIRED', () => start(ownerD.principal, lateDOp.id), 'launch with an expired, never-activated invitation', 'GRANT_EXPIRED');
    pass('expired grants and expired invitations fail closed for launch, spend, activation, status and readiness; a new grant materialises the expiry');

    // ── Group 8 · the A21.01 payment freeze still precedes the beta gate ────────────────────────
    const usedBefore = (await grantRow(grantA)).missionsUsed;
    const paidOp = await readyOp(ownerA.principal, 'paid', 'qa-a2102-paid-offer');
    await expectDomainError('PAYMENT_REQUIRED', () => start(ownerA.principal, paidOp.id), 'priced order under the payment freeze');
    assert((await grantRow(grantA)).missionsUsed === usedBefore, 'a frozen paid launch consumes no beta quota');
    pass('the payment freeze still refuses priced orders first (PAYMENT_REQUIRED) and the beta gate grants no payment entitlement');

    // ── Group 9 · audit and ledger completeness ─────────────────────────────────────────────────
    const kinds = new Set((await db.select({ kind: betaGrantEvents.kind }).from(betaGrantEvents)).map(row => row.kind));
    for (const kind of ['INVITED', 'ACTIVATED', 'ACTIVATION_DENIED', 'REVOKED', 'EXPIRED', 'MISSION_ADMITTED', 'MISSION_RESUMED', 'LAUNCH_DENIED', 'SPEND_RESERVED', 'SPEND_SETTLED', 'SPEND_DENIED']) {
      assert(kinds.has(kind as never), 'beta ledger contains ' + kind);
    }
    const detail = await http(base, '/v1/platform/beta-grants/' + grantA, { headers: support });
    assert(detail.status === 200 && (detail.body.events as unknown[]).length > 5 && (detail.body.grant as { missionsUsed: number }).missionsUsed === 3, 'SUPPORT reads the grant detail with its ledger');
    const operatorAudit = await db.select().from(platformAdminAudit).where(sql`${platformAdminAudit.action} IN ('GRANT_BETA_ACCESS','REVOKE_BETA_ACCESS')`);
    assert(operatorAudit.filter(row => row.outcome === 'SUCCESS').length === 6, 'six successful operator mutations audited (5 grants + 1 revocation)');
    assert(operatorAudit.filter(row => row.outcome === 'DENIED').length >= 5, 'operator-level refusals (self-grant, invalid, conflict, double revoke) audited');
    const crossLedger = await betaStore.listEvents({ workspaceId: ownerB.workspaceId, limit: 100 });
    assert(crossLedger.every(event => event.workspaceId === ownerB.workspaceId), 'ledger reads are workspace-scoped');
    pass('every grant, revocation and denial is in platform_admin_audit; lifecycle and usage are in beta_grant_events');

    console.log('Beta access QA PASSED: ' + String(groups) + ' groups, ' + String(assertions) + ' assertions in ' + String(Math.round((Date.now() - startedAt) / 1000)) + 's');
    console.log('BOUNDARY: real PostgreSQL, real services and HTTP API; no worker/Hermes/provider ran (spend exercised through BudgetService.reserve/settle); completion and expiry use explicit fixture shortcuts; no browser ran.');
  } finally {
    await app?.close().catch(() => undefined);
    await connection?.close().catch(() => undefined);
    await qa.drop();
    console.log('QA database dropped: ' + qa.name);
  }
}

main().catch(error => {
  console.error('QA verification FAILED:', error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});

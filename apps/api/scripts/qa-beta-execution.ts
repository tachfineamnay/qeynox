import { prepareQaPackStep } from './qa-pack-step';
/**
 * MISSION A21.03 — FREE BETA EXECUTION AUTHORIZATION QA (disposable real PostgreSQL + real HTTP API).
 *
 * Verifies that eligible beta testers can execute every A16 business pack without paying, through a
 * DISTINCT, non-financial beta authorization, and that nothing about payments is faked or bypassed:
 *
 *   0. Migration 0027 is additive; `amount_due_now_minor = 0` and the bindings are enforced by the DB.
 *   1. Default PAYMENTS_DISABLED: behaviour unchanged — priced packs stay PAYMENT_REQUIRED, no beta row.
 *   2. BETA_FREE + ACTIVE grant, all 8 packs over HTTP: free packs stay AUTHORIZED (no beta row); priced
 *      packs become BETA_AUTHORIZED with a beta authorization bound to workspace, operation, revision,
 *      quote, acceptance, order, scope hash, offer version, terms and grant, list price unchanged and
 *      amount due now 0. Read models (commercial, payment, readiness) say so without claiming payment.
 *   3. All 8 packs executed and delivered (start → ToolBroker → evidence → claims → human review →
 *      RESULT_REVIEW approval → delivery) with no Stripe and no payment rows; priced orders end
 *      BETA_DELIVERED, never DELIVERED/AUTHORIZED/PAID/CAPTURED. One delivery runs over HTTP.
 *   4. Concurrent acceptance: replays, different keys and competing quotes yield one order and one
 *      beta authorization; losers get CONFLICT.
 *   5. Revoked grant: start, retry and delivery are refused (and ledgered); the authorization is reported
 *      invalid; a new grant does not revive it; new acceptances stay PAYMENT_REQUIRED.
 *   6. Expired grant: start and delivery are refused; readiness and the commercial view say why.
 *   7. Changed plan: a revision change invalidates the old scope; tampered bindings are detected.
 *   8. Cross-tenant: no read, accept, beta-authorize, start or deliver across workspaces.
 *   9. Explicit conversion of a PAYMENT_REQUIRED order accepted before the grant (idempotent; refused
 *      with payment history, without a grant, or outside BETA_FREE).
 *  10. Mode switched back to PAYMENTS_DISABLED: existing beta authorizations stop authorizing (fail closed).
 *  11. Mandatory controls are untouched: beta quota, budget, ToolBroker allowlist and consent, runtime
 *      readiness and the human RESULT_REVIEW approval.
 *  12. Global invariant: no payment, refund or payment-event row exists for any beta order.
 *
 * HONEST BOUNDARY:
 * - No worker, Hermes engine or orchestrator runs. Step attempts are moved to RUNNING and completed
 *   through the real StepProgression service, exactly like `qa:business-packs`.
 * - Providers are local fakes behind the REAL ToolBroker and PgToolLedger: Brave Search through its
 *   transport seam, World Bank through a QA replay connector that reuses the real connector's tool
 *   definitions (input/output schemas). No external network is contacted.
 * - Grant expiry is simulated by moving the stored expiry into the past; the code reads the real clock.
 * - No browser runs; web and Control changes are typechecked, built and covered by web tests only.
 *
 * Run: pnpm qa:beta-execution   (requires QEYNOX_QA_DATABASE_URL; disposable local database only)
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  applyConfigurationSchema, serviceListSchema, serviceRequestResultSchema,
  type BusinessPackDomain,
} from '@qeynox/contracts';
import { DomainError, type ID, type Principal } from '@qeynox/domain';
import {
  BetaAccessStore, QeyNoxStore, approvals, attempts, betaExecutionAuthorizations, betaGrantEvents, betaGrants,
  commercialOrders, connectDatabase, identityMemberships, identityUsers, identityWorkspaces, operations, paymentEvents,
  payments, quoteAcceptances, quotes, refunds, resultDocuments, runMigrations, sourceSnapshots,
} from '@qeynox/persistence';
import {
  BraveSearchConnector, EgressPolicy, PgToolLedger, ToolBroker, ToolRegistry, WorldBankConnector,
  braveSearchManifest, worldBankManifest,
  type ConnectorCall, type PermissionContext, type ToolConnector, type ToolContext,
} from '@qeynox/tools';
import {
  BetaExecutionAuthorizer, ClaimsService, CommerceService, ConfigurationService, InterruptionService, OperationControlService,
  OperationExecutionService, PlanReadService, PlanRevisionService, REQUIRED_PROVIDER_BY_PACK, ResultAssembler, ResultDeliveryService,
  StepProgression, computeFinancialSensitivity, computeProcessDiagnostics, failClosedRuntime, projectDeliverableToResultSummary,
  resolveCommercePolicy, validatePackDeliverable,
  type RuntimeReadiness,
} from '@qeynox/application';
import { AppModule } from '../src/app.module';
import { DomainExceptionFilter } from '../src/transport/domain-exception.filter';
import { createIsolatedQaDatabase } from './qa-isolated-database';
import { startVerifiedRuntime, type VerifiedRuntime } from './qa-runtime-fixtures';
import { seedQaBetaGrant } from './qa-beta-fixture';
import { VALID_PACK_REQUESTS, buildValidDeliverables } from './qa-pack-fixtures';
import { makeRuntimeReadiness as qaRuntimeFixture } from '@qeynox/application';
// A21.07 QA fixture (test infrastructure only): this suite exercises launches, not runtime probing.
// The launch gate itself is proven against real probes in qa:runtime-verification.
const qaVerifiedRuntime = () => qaRuntimeFixture({ engineVerifiedLive: true, engineEvidence: 'qa-fixture:qa-beta-execution', orchestratorVerifiedLive: true, orchestratorEvidence: 'qa-fixture:qa-beta-execution' });

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
    throw new Error('EXPECTED ' + code + (reason ? '/' + reason : '') + ' for ' + label + ', got ' + (error instanceof DomainError ? error.code + ' (' + error.message + ' ' + JSON.stringify(error.context ?? {}) + ')' : String(error)));
  }
  throw new Error('EXPECTED ' + code + ' for ' + label + ', but no error was raised');
}

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');
const suiteBundlePath = resolve(repoRoot, 'infra/operator/a16-business-packs.json');
const suiteRaw = JSON.parse(readFileSync(suiteBundlePath, 'utf8')) as { idempotencyKey: string; services: { pack: BusinessPackDomain; offerId: string; capabilityId: string }[]; entries: unknown[] };
const suiteApply = applyConfigurationSchema.parse({ idempotencyKey: suiteRaw.idempotencyKey, entries: suiteRaw.entries });
const capabilityByPack = new Map(suiteRaw.services.map(s => [s.pack, s.capabilityId]));
const slotByPack = (pack: BusinessPackDomain) => Number(/capability-slot-(\d+)-v1/.exec(capabilityByPack.get(pack)!)![1]);

/** Published A16 prices (infra/operator/a16-business-packs.json). Asserted, never invented. */
const PUBLISHED: Readonly<Record<BusinessPackDomain, { amountMinor: number; free: boolean }>> = {
  research: { amountMinor: 0, free: true }, strategy: { amountMinor: 29000, free: false }, marketing: { amountMinor: 24000, free: false },
  seo: { amountMinor: 19000, free: false }, sales: { amountMinor: 22000, free: false }, operations: { amountMinor: 0, free: true },
  'financial-analysis': { amountMinor: 34000, free: false }, content: { amountMinor: 18000, free: false },
};

// A21.07: built through the labelled QA builder so the fixture carries a full VERIFIED record.
const OPERATIONAL_RUNTIME: RuntimeReadiness = qaRuntimeFixture({ engineVerifiedLive: true, engineEvidence: 'qa-a21-03-fixture', orchestratorVerifiedLive: true, orchestratorEvidence: 'qa-a21-03-fixture' });

/**
 * QA replay for the World Bank connector: the REAL tool definitions (input/output schemas, scopes,
 * capability allowlist) with a canned, schema-valid response instead of a network call.
 */
class QaWorldBankReplay implements ToolConnector {
  readonly id = 'world-bank';
  readonly version = '1';
  private readonly real: WorldBankConnector;
  constructor(capabilities: readonly ID[]) { this.real = new WorldBankConnector(capabilities, new EgressPolicy({ attested: true, allowedHosts: ['api.worldbank.org'] })); }
  definitions() { return this.real.definitions(); }
  async invoke(name: string, version: string, input: unknown, _context: ToolContext) {
    if (name !== 'indicator' || version !== '1') throw new DomainError('UNSUPPORTED', 'Unknown World Bank tool');
    const values = input as { country: string; indicator: string };
    const country = values.country.toUpperCase(), indicator = values.indicator.toUpperCase();
    const sourceUri = 'https://api.worldbank.org/v2/country/' + country + '/indicator/' + indicator + '?format=json&per_page=3';
    const observations = ['2023', '2022', '2021'].map((date, index) => ({
      country: { id: country, value: country }, indicator: { id: indicator, value: indicator }, date, value: 100 + index,
    }));
    return { value: { provider: 'world-bank' as const, country, indicator, observations, sourceUri, retrievedAt: new Date().toISOString() }, sourceUri };
  }
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

async function main(): Promise<void> {
  if (!process.env.QEYNOX_QA_DATABASE_URL) {
    console.log('BLOCKED: QEYNOX_QA_DATABASE_URL is not set. The beta-execution QA suite requires an isolated PostgreSQL database; no result is claimed.');
    process.exitCode = 1;
    return;
  }
  const startedAt = Date.now();
  const qa = await createIsolatedQaDatabase();
  process.env.DATABASE_URL = qa.url;
  process.env.QEYNOX_ALLOW_REGISTRATION = 'true';
  process.env.QEYNOX_SERVICE_CATALOG_PATH = suiteBundlePath;
  process.env.QEYNOX_WORLD_BANK_ENABLED = 'true';
  // P22 BIS: the Brave fixture provider is configured explicitly (switch + QA fixture credential)
  // so every pack's required provider resolves deterministically inside this isolated run. The
  // fixture credential is never used for a live call — Brave traffic below goes through the
  // injected local fixture connector, never the public Brave API.
  process.env.QEYNOX_BRAVE_SEARCH_ENABLED = 'true';
  process.env.QEYNOX_BRAVE_SEARCH_API_KEY = 'qa-fixture-brave-credential-not-a-secret';
  delete process.env.QEYNOX_STRIPE_SECRET_KEY;
  delete process.env.QEYNOX_STRIPE_WEBHOOK_SECRET;
  process.env.QEYNOX_NETWORK_POLICY_ATTESTED = 'true';
  process.env.QEYNOX_EGRESS_ALLOWED_HOSTS = 'api.worldbank.org,api.search.brave.com';
  delete process.env.QEYNOX_COMMERCE_MODE;
  let connection: ReturnType<typeof connectDatabase> | undefined;
  let app: INestApplication | undefined;
  let runtime: VerifiedRuntime | undefined;
  try {
    // ── Group 0 · additive migration ─────────────────────────────────────────────────────────────
    const report = await runMigrations(qa.url);
    assert(report.applied.length === report.total && report.applied.includes('0027_beta_execution_authorization.sql'), 'disposable database migrated including 0027_beta_execution_authorization.sql');
    connection = connectDatabase(qa.url);
    const db = connection.db;
    const store = new QeyNoxStore(db);
    const checks = await db.execute(sql`SELECT conname FROM pg_constraint WHERE conrelid = 'raas_beta_authorizations'::regclass AND contype IN ('c','f','u') ORDER BY 1`);
    const names = checks.rows.map(row => (row as { conname: string }).conname);
    assert(names.includes('raas_beta_authorizations_amount_due_zero') && names.includes('raas_beta_authorizations_status_range') && names.includes('raas_beta_authorizations_delivery_consistent'), 'amount-due, status and delivery CHECK constraints exist');
    const fks = await db.execute(sql`SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid = 'raas_beta_authorizations'::regclass AND contype = 'f'`);
    assert((fks.rows[0] as { n: number }).n === 5, 'workspace, quote, acceptance, order and grant are foreign keys');
    const revisionUnique = await db.execute(sql`SELECT indexdef FROM pg_indexes WHERE indexname = 'raas_beta_authorization_operation_revision_unique'`);
    assert(String((revisionUnique.rows[0] as { indexdef?: string } | undefined)?.indexdef ?? '').startsWith('CREATE UNIQUE INDEX'), 'one beta authorization per (operation, revision)');
    const orderStateCheck = await db.execute(sql`SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid = 'raas_orders'::regclass AND contype = 'c'`);
    assert((orderStateCheck.rows[0] as { n: number }).n === 0, 'raas_orders is unchanged (no constraint added to the existing table)');
    pass('migration 0027 is additive: raas_beta_authorizations with amount_due_now = 0, bindings as foreign keys, one per revision');

    // ── Fixture · operator configuration and identities ──────────────────────────────────────────
    const operatorId = randomUUID(), operatorWorkspace = randomUUID();
    await db.insert(identityUsers).values({ id: operatorId, email: 'qa-a2103-op-' + operatorId + '@example.invalid' });
    await db.insert(identityWorkspaces).values({ id: operatorWorkspace, name: 'QA A21.03 Operator Workspace', createdBy: operatorId });
    await db.insert(identityMemberships).values({ id: randomUUID(), userId: operatorId, workspaceId: operatorWorkspace, role: 'OWNER', status: 'ACTIVE' });
    const operator: Principal = { userId: operatorId as ID, workspaceId: operatorWorkspace as ID, roles: ['OWNER', 'ADMIN'] };
    process.env.QEYNOX_OPERATOR_USER_IDS = operatorId;
    const config = new ConfigurationService(store);
    const applied = await config.apply(operator, { idempotencyKey: suiteApply.idempotencyKey, entries: suiteApply.entries });
    assert(applied.changes.length > 0, 'A16 suite configuration applied');
    const budgetEntry = suiteApply.entries.find(entry => entry.domain === 'BUDGET_POLICY')!;

    // Workspaces are created as real users would (HTTP registration) and get budgets and grants as an
    // operator would issue them. The API reads QEYNOX_COMMERCE_MODE at boot: BETA_FREE here.
    // A21.07: HTTP launches pass the runtime gate only on real probe evidence. Local Hermes/Hatchet
    // fixtures (QA infrastructure) are probed by the API's own monitor; nothing is flagged as verified.
    runtime = await startVerifiedRuntime();
    process.env.QEYNOX_COMMERCE_MODE = 'BETA_FREE';
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
    app.useGlobalFilters(new DomainExceptionFilter());
    await app.listen(0, '127.0.0.1');
    const base = 'http://127.0.0.1:' + String((app.getHttpServer().address() as { port: number }).port);
    interface Tenant { label: string; principal: Principal; headers: Record<string, string>; workspaceId: string; userId: string }
    const register = async (label: string, opts: { budget?: boolean } = {}): Promise<Tenant> => {
      const reg = await http(base, '/v1/auth/register', { json: { email: 'qa-a2103-' + label + '-' + randomUUID().slice(0, 8) + '@example.invalid', password: 'qa-a21-03-strong-password-' + label, workspaceName: 'QA A21.03 ' + label } });
      assert(reg.status === 201, 'registered workspace ' + label);
      const auth = reg.body as unknown as { token: string; userId: string; workspaceId: string };
      const principal: Principal = { userId: auth.userId as ID, workspaceId: auth.workspaceId as ID, roles: ['OWNER'] };
      if (opts.budget !== false) {
        process.env.QEYNOX_OPERATOR_USER_IDS = operatorId + ',' + auth.userId;
        await config.apply(principal, { idempotencyKey: 'qa-a2103-budget-' + label, entries: [budgetEntry] });
        process.env.QEYNOX_OPERATOR_USER_IDS = operatorId;
      }
      return { label, principal, headers: { authorization: 'Bearer ' + auth.token, 'x-qeynox-workspace': auth.workspaceId }, workspaceId: auth.workspaceId, userId: auth.userId };
    };

    const listed = serviceListSchema.parse((await http(base, '/v1/services', { headers: (await register('catalogue-reader', { budget: false })).headers })).body);
    assert(listed.length === 8, 'GET /v1/services lists the 8 A16 packs');
    for (const summary of listed) {
      const published = PUBLISHED[summary.packDomain!];
      assert(summary.amountMinor === published.amountMinor && summary.isExplicitlyFree === published.free, summary.offerId + ' keeps its published price ' + String(published.amountMinor) + ' (free=' + String(published.free) + ')');
    }
    const offerByPack = new Map(listed.map(summary => [summary.packDomain!, summary]));

    const requestMission = async (tenant: Tenant, pack: BusinessPackDomain) => {
      const summary = offerByPack.get(pack)!;
      const created = await http(base, '/v1/services/' + encodeURIComponent(summary.offerId) + '/requests', { headers: tenant.headers, json: { service: summary.contractKey, input: VALID_PACK_REQUESTS[pack] } });
      assert(created.status === 201, tenant.label + ': ' + pack + ' mission requested (201)');
      const parsed = serviceRequestResultSchema.parse(created.body);
      return { operationId: parsed.operationId as ID, revisionId: parsed.revisionId as ID, offerId: summary.offerId };
    };
    const quoteOverHttp = async (tenant: Tenant, mission: { operationId: ID; revisionId: ID; offerId: string }) => {
      const quoted = await http(base, '/v1/operations/' + mission.operationId + '/commercial/quote', { headers: tenant.headers, json: { offerId: mission.offerId, revisionId: mission.revisionId } });
      assert(quoted.status === 201, tenant.label + ': quote created over HTTP');
      return quoted.body as unknown as { id: ID; amountMinor: number; currency: string; scopeHash: string; termsVersion: string };
    };
    const acceptOverHttp = async (tenant: Tenant, mission: { operationId: ID }, quoteId: string, key = 'qa-a2103-accept-' + randomUUID()) =>
      http(base, '/v1/operations/' + mission.operationId + '/commercial/quotes/' + quoteId + '/accept', { headers: tenant.headers, json: { idempotencyKey: key } });
    const betaRowsFor = async (orderId: string) => db.select().from(betaExecutionAuthorizations).where(eq(betaExecutionAuthorizations.orderId, orderId));
    const orderOf = async (orderId: string) => (await db.select().from(commercialOrders).where(eq(commercialOrders.id, orderId)))[0]!;
    const paymentFootprint = async () => {
      const [p] = (await db.execute(sql`SELECT (SELECT count(*) FROM raas_payments)::int AS p, (SELECT count(*) FROM raas_refunds)::int AS r, (SELECT count(*) FROM raas_payment_events)::int AS e`)).rows as { p: number; r: number; e: number }[];
      return p!;
    };

    // ── Group 1 · default PAYMENTS_DISABLED keeps A21.01 behaviour ───────────────────────────────
    const disabledPolicy = resolveCommercePolicy(undefined);
    assert(disabledPolicy.mode === 'PAYMENTS_DISABLED' && !disabledPolicy.betaFree, 'unset QEYNOX_COMMERCE_MODE resolves to PAYMENTS_DISABLED');
    const legacy = await register('legacy-disabled');
    await seedQaBetaGrant(db, legacy.workspaceId);
    const disabledCommerce = new CommerceService(store, disabledPolicy);
    for (const pack of ['strategy', 'research'] as const) {
      const mission = await requestMission(legacy, pack);
      const quote = await disabledCommerce.quote(legacy.principal, mission.operationId, mission.offerId, mission.revisionId) as { id: ID };
      const accepted = await disabledCommerce.accept(legacy.principal, quote.id, 'qa-a2103-legacy-' + pack);
      const expected = PUBLISHED[pack].free ? 'AUTHORIZED' : 'PAYMENT_REQUIRED';
      assert(accepted.state === expected, 'PAYMENTS_DISABLED + active grant: ' + pack + ' order is ' + expected + ' (unchanged)');
      assert((await betaRowsFor(accepted.orderId!)).length === 0, 'PAYMENTS_DISABLED: no beta authorization for ' + pack);
      if (!PUBLISHED[pack].free) {
        const legacyOp = await store.getOperation(legacy.principal, mission.operationId);
        await expectDomainError('PAYMENT_REQUIRED', () => new OperationExecutionService(store, qaVerifiedRuntime).start(legacy.principal, mission.operationId, legacyOp.version, 'qa-a2103-legacy-start-' + pack), 'priced PAYMENT_REQUIRED order cannot start');
        await expectDomainError('BETA_ACCESS_REQUIRED', () => disabledCommerce.authorizeBeta(legacy.principal, mission.operationId), 'conversion refused outside BETA_FREE', 'BETA_AUTHORIZATION_BETA_MODE_DISABLED');
      }
    }
    pass('default PAYMENTS_DISABLED: priced packs stay PAYMENT_REQUIRED even with an active grant, free packs stay AUTHORIZED, no beta authorization is created');

    // ── Group 2 · BETA_FREE + ACTIVE grant: all 8 packs accepted over HTTP ────────────────────────
    const tenantA = await register('tenant-a');
    const grantA = await seedQaBetaGrant(db, tenantA.workspaceId);
    const missionsA = new Map<BusinessPackDomain, { operationId: ID; revisionId: ID; offerId: string; orderId: string }>();
    for (const pack of Object.keys(PUBLISHED) as BusinessPackDomain[]) {
      const mission = await requestMission(tenantA, pack);
      const quote = await quoteOverHttp(tenantA, mission);
      assert(quote.amountMinor === PUBLISHED[pack].amountMinor && quote.currency === 'EUR', pack + ': quote keeps the published price ' + String(PUBLISHED[pack].amountMinor) + ' EUR');
      const accepted = await acceptOverHttp(tenantA, mission, quote.id);
      assert(accepted.status === 201, pack + ': acceptance over HTTP (201)');
      const outcome = accepted.body as unknown as { orderId: string; state: string; betaAuthorizationId?: string };
      const order = await orderOf(outcome.orderId);
      const rows = await betaRowsFor(outcome.orderId);
      const [acceptance] = await db.select().from(quoteAcceptances).where(eq(quoteAcceptances.quoteId, quote.id));
      const [quoteRow] = await db.select().from(quotes).where(eq(quotes.id, quote.id));
      assert(acceptance && acceptance.scopeHash === quote.scopeHash && acceptance.termsVersion === '2026-11-a16', pack + ': terms acceptance recorded with the quoted scope hash and terms version');
      assert(order.amountMinor === PUBLISHED[pack].amountMinor && order.currency === 'EUR', pack + ': order keeps the published price');
      if (PUBLISHED[pack].free) {
        assert(outcome.state === 'AUTHORIZED' && order.state === 'AUTHORIZED' && rows.length === 0, pack + ': explicitly free offer is AUTHORIZED as before, with no beta authorization');
      } else {
        assert(outcome.state === 'BETA_AUTHORIZED' && order.state === 'BETA_AUTHORIZED', pack + ': priced order is BETA_AUTHORIZED (not AUTHORIZED, not PAID)');
        assert(rows.length === 1 && rows[0]!.id === outcome.betaAuthorizationId, pack + ': exactly one beta authorization');
        const row = rows[0]!;
        assert(row.workspaceId === tenantA.workspaceId && row.operationId === mission.operationId && row.revisionId === mission.revisionId, pack + ': authorization bound to workspace, operation and revision');
        assert(row.quoteId === quote.id && row.acceptanceId === acceptance.id && row.orderId === outcome.orderId, pack + ': authorization bound to quote, acceptance and order');
        assert(row.scopeHash === quote.scopeHash && row.offerId === mission.offerId && row.offerVersion === quoteRow!.offerVersion && row.termsVersion === quote.termsVersion, pack + ': authorization bound to scope hash, offer version and terms');
        assert(row.betaGrantId === grantA.grantId && row.status === 'AUTHORIZED' && row.deliveredAt === null, pack + ': authorization linked to the ACTIVE grant');
        assert(row.listAmountMinor === PUBLISHED[pack].amountMinor && row.currency === 'EUR' && row.amountDueNowMinor === 0, pack + ': list price unchanged, amount due now 0');
        const event = await db.execute(sql`SELECT payload FROM operation_events WHERE operation_id = ${mission.operationId} AND kind = 'BETA_EXECUTION_AUTHORIZED'`);
        assert(event.rows.length === 1, pack + ': BETA_EXECUTION_AUTHORIZED recorded in the operation timeline');
      }
      // Read models.
      const commercial = await http(base, '/v1/operations/' + mission.operationId + '/commercial', { headers: tenantA.headers });
      const view = commercial.body as unknown as { executionAuthorized: boolean; payment: { required: boolean }; betaAuthorization: { basis: string; valid: boolean; amountDueNowMinor: number; listAmountMinor: number; denial: string | null } | null; betaAuthorizationAvailable: boolean };
      assert(commercial.status === 200 && view.executionAuthorized === true && view.payment.required === false && view.betaAuthorizationAvailable === false, pack + ': GET commercial reports execution authorized, no payment required');
      if (!PUBLISHED[pack].free) {
        assert(view.betaAuthorization?.basis === 'FREE_BETA' && view.betaAuthorization.valid === true && view.betaAuthorization.amountDueNowMinor === 0 && view.betaAuthorization.listAmountMinor === PUBLISHED[pack].amountMinor && view.betaAuthorization.denial === null, pack + ': GET commercial exposes the free-beta authorization (list price, 0 due)');
        const paymentView = await http(base, '/v1/operations/' + mission.operationId + '/payment', { headers: tenantA.headers });
        const pv = paymentView.body as unknown as { orderState: string; payment: unknown; executionAuthorized: boolean; canStartCheckout: boolean; commerce: { mode: string; betaFree: boolean; paymentsAvailable: boolean } };
        assert(paymentView.status === 200 && pv.orderState === 'BETA_AUTHORIZED' && pv.payment === null && pv.executionAuthorized === false && pv.canStartCheckout === false, pack + ': payment view shows no payment and no payment-based authorization');
        assert(pv.commerce.mode === 'BETA_FREE' && pv.commerce.betaFree === true && pv.commerce.paymentsAvailable === false, pack + ': payments stay frozen in BETA_FREE');
      } else {
        assert(view.betaAuthorization === null, pack + ': no beta authorization reported for a free offer');
      }
      const readiness = await new PlanReadService(store, () => OPERATIONAL_RUNTIME, resolveCommercePolicy('BETA_FREE')).readiness(tenantA.principal, mission.operationId);
      assert(readiness.canStart === true && readiness.prerequisites.executionAuthorization.basis === (PUBLISHED[pack].free ? 'FREE_OFFER' : 'FREE_BETA'), pack + ': readiness canStart with basis ' + readiness.prerequisites.executionAuthorization.basis);
      assert(readiness.prerequisites.betaAuthorization.valid === !PUBLISHED[pack].free && readiness.prerequisites.betaAuthorization.amountDueNowMinor === (PUBLISHED[pack].free ? null : 0), pack + ': readiness betaAuthorization block');
      const unattested = await new PlanReadService(store, failClosedRuntime, resolveCommercePolicy('BETA_FREE')).readiness(tenantA.principal, mission.operationId);
      assert(unattested.canStart === false && unattested.blockers.some(b => b.category === 'ENGINE'), pack + ': runtime readiness stays mandatory (fail-closed runtime → cannot start)');
      missionsA.set(pack, { ...mission, orderId: outcome.orderId });
    }
    assert(JSON.stringify(await paymentFootprint()) === JSON.stringify({ p: 0, r: 0, e: 0 }), 'no payment, refund or payment-event row exists after 8 acceptances');
    pass('BETA_FREE + ACTIVE grant: 8 packs quoted and accepted over HTTP at published prices; 6 priced orders BETA_AUTHORIZED with a bound beta authorization (0 due), 2 free offers AUTHORIZED unchanged; read models truthful');

    // ── P22 BIS · provider readiness truthfulness ───────────────────────────────────────────────
    // With the required providers disabled the suite must never claim all 8 packs can start:
    // flipping the Brave switch off has to surface a PROVIDER_NOT_CONFIGURED blocker.
    process.env.QEYNOX_BRAVE_SEARCH_ENABLED = 'false';
    const disabledProviderMission = missionsA.get('strategy')!;
    const disabledProviderReadiness = await new PlanReadService(store, () => OPERATIONAL_RUNTIME, resolveCommercePolicy('BETA_FREE')).readiness(tenantA.principal, disabledProviderMission.operationId);
    assert(disabledProviderReadiness.canStart === false && disabledProviderReadiness.blockers.some(blocker => blocker.code === 'PROVIDER_NOT_CONFIGURED'), 'a disabled required provider blocks readiness instead of claiming all 8 packs startable');
    process.env.QEYNOX_BRAVE_SEARCH_ENABLED = 'true';

    // ── Group 3 · all 8 packs executed and delivered without Stripe ──────────────────────────────
    const allCapabilities = [...capabilityByPack.values()] as ID[];
    const registry = new ToolRegistry();
    registry.registerBundle({
      connector: new BraveSearchConnector(allCapabilities, new EgressPolicy({ attested: true, allowedHosts: ['api.search.brave.com'] }), 'qa-local-key', {
        async get() {
          return { status: 200, body: JSON.stringify({ web: { results: [{ title: 'QA public benchmark', url: 'https://example-public-source.org/enterprise-ops-benchmark', description: 'QA fixture result.' }] } }) };
        },
      }),
      manifest: braveSearchManifest,
    });
    registry.registerBundle({ connector: new QaWorldBankReplay(allCapabilities), manifest: worldBankManifest });
    const broker = new ToolBroker(registry, new PgToolLedger(db));
    const deliverables = buildValidDeliverables();
    const expectedOpsDiag = computeProcessDiagnostics((VALID_PACK_REQUESTS.operations as { workflowStages: Parameters<typeof computeProcessDiagnostics>[0] }).workflowStages, 48);
    const fin = VALID_PACK_REQUESTS['financial-analysis'] as { baselineMetrics: Parameters<typeof computeFinancialSensitivity>[0]; scenarios: Parameters<typeof computeFinancialSensitivity>[1] };
    const expectedFinSens = computeFinancialSensitivity(fin.baselineMetrics, fin.scenarios);
    const claimsService = new ClaimsService(store);
    const progression = new StepProgression(store);
    const assembler = new ResultAssembler(store);
    const controls = new OperationControlService(store);

    const permissionFor = (actor: Principal, pack: BusinessPackDomain, operationId: ID, revisionId: ID, attemptId: ID, overrides: Partial<PermissionContext> = {}): PermissionContext => {
      const provider = REQUIRED_PROVIDER_BY_PACK[pack];
      return {
        principal: actor, operationId, planRevisionId: revisionId, stepAttemptId: attemptId, capabilityId: capabilityByPack.get(pack) as ID,
        profileId: ('profile-business-' + String(slotByPack(pack)) + '-v1') as ID, profileVersion: 1,
        allowedConnectorTools: [provider === 'brave-search' ? 'brave-search:web@1' : 'world-bank:indicator@1'],
        consentScopes: provider === 'brave-search' ? ['web:search'] : [], approvedRequests: [], remainingCostUnits: 100, remainingToolCalls: 3,
        ...overrides,
      };
    };
    const callFor = (pack: BusinessPackDomain, operationId: ID, revisionId: ID, attemptId: ID): ConnectorCall => {
      const provider = REQUIRED_PROVIDER_BY_PACK[pack];
      return {
        operationId, planRevisionId: revisionId, stepAttemptId: attemptId, capabilityId: capabilityByPack.get(pack) as ID,
        connectorId: provider, toolName: provider === 'brave-search' ? 'web' : 'indicator', version: '1',
        input: provider === 'brave-search'
          ? { query: 'qa a21.03 ' + pack + ' public benchmark', count: 3 }
          : pack === 'research' ? { country: 'MA', indicator: 'NY.GDP.PCAP.CD', mostRecent: 3 } : { country: 'FR', indicator: 'FP.CPI.TOTL.ZG', mostRecent: 3 },
        idempotencyKey: 'qa-a2103-tool-' + randomUUID(), intentId: randomUUID() as ID,
      };
    };

    /** Runs a launched mission to an APPROVED RESULT_REVIEW (no delivery). */
    const runToReview = async (actor: Principal, pack: BusinessPackDomain, operationId: ID, revisionId: ID, startKey: string) => {
      const before = await store.getOperation(actor, operationId);
      await new OperationExecutionService(store, qaVerifiedRuntime).start(actor, operationId, before.version, startKey);
      assert((await store.getOperation(actor, operationId)).status === 'RUNNING', pack + ': launched into RUNNING');
      const [firstAttempt] = await db.select().from(attempts).where(and(eq(attempts.operationId, operationId), eq(attempts.state, 'PENDING')));
      const attemptId = firstAttempt!.id as ID;
      // ToolBroker stays mandatory: the call goes through the real broker, allowlist and ledger.
      const { deliverable, capturedUris } = deliverables[pack];
      const provider = REQUIRED_PROVIDER_BY_PACK[pack];
      // One real broker call (allowlist, consent, budget, ledger) per cited source: strategy and content
      // require two evidence-backed sources by verification policy.
      const recorded: { sourceId: ID; evidenceId: ID; digest: string }[] = [];
      for (const citedUri of capturedUris) {
        const toolResult = await broker.invoke(callFor(pack, operationId, revisionId, attemptId), permissionFor(actor, pack, operationId, revisionId, attemptId));
        const sourceId = randomUUID() as ID, evidenceId = randomUUID() as ID, digest = toolResult.provenance.responseDigest;
        await store.recordSource({ id: sourceId, workspaceId: actor.workspaceId, operationId, uri: citedUri, provider, title: 'QA A21.03 ' + pack + ' source', retrievedAt: toolResult.provenance.retrievedAt, fingerprint: digest });
        await store.recordEvidence({ id: evidenceId, operationId, sourceId, stepAttemptId: attemptId, statement: 'QA A21.03 evidence for ' + pack + ' from ' + citedUri, observedAt: new Date().toISOString(), status: 'UNVERIFIED', limitations: ['QA fixture evidence'] });
        await db.insert(sourceSnapshots).values({ id: randomUUID(), workspaceId: actor.workspaceId, operationId, sourceId, provider, retrievedAt: toolResult.provenance.retrievedAt, sha256: digest, citationUri: citedUri, createdAt: new Date().toISOString() });
        recorded.push({ sourceId, evidenceId, digest });
      }
      const { sourceId, evidenceId } = recorded[0]!;
      const validated = validatePackDeliverable(pack, deliverable, {
        capturedSourceUris: capturedUris,
        ...(pack === 'operations' ? { expectedDiagnostics: expectedOpsDiag } : {}),
        ...(pack === 'financial-analysis' ? { expectedSensitivity: expectedFinSens } : {}),
      });
      const projected = projectDeliverableToResultSummary(validated);
      const claim = await claimsService.register(actor, { operationId, attemptId, statement: projected.title + ' — QA A21.03 evidenced finding for ' + pack, kind: 'PROVIDER_OBSERVATION' });
      for (const link of recorded) await claimsService.attach(actor, claim.id, link.sourceId, 'SUPPORTS', link.evidenceId, link.digest);
      const auto = await claimsService.assess(actor, { claimId: claim.id, capabilityId: capabilityByPack.get(pack) as ID, policyVersion: 1, reason: 'Automated policy check' });
      assert(auto.status === 'NEEDS_HUMAN_REVIEW', pack + ': verification policy requires human review — got ' + JSON.stringify(auto));
      const reviewed = await claimsService.assess(actor, { claimId: claim.id, capabilityId: capabilityByPack.get(pack) as ID, policyVersion: 1, reason: 'QA reviewer verified the citation', reviewerDecision: 'SUPPORTED' });
      assert(reviewed.status === 'SUPPORTED', pack + ': human reviewer marked the claim SUPPORTED');
      let state = '';
      for (let pass = 0; pass < 12 && state !== 'AWAITING_REVIEW'; pass++) {
        const pending = await db.select().from(attempts).where(and(eq(attempts.operationId, operationId), eq(attempts.state, 'PENDING')));
        if (!pending.length) break;
        for (const current of pending) {
          await db.update(attempts).set({ state: 'RUNNING', payload: { ...current.payload, state: 'RUNNING', startedAt: new Date().toISOString(), version: current.payload.version + 1 } }).where(eq(attempts.id, current.id));
          const finalStep = await prepareQaPackStep(store, actor, current.payload, validated);
          if (finalStep.businessDeliverable) {
            assert(finalStep.claimIds.length > 0, pack + ': validated final output registered domain claims');
            for (const claimId of finalStep.claimIds) {
              // The QA corpus deliberately supplies corroborating captures (two distinct sources for
              // strategy/content). Link those through ClaimsService; never weaken minimumSources.
              for (const link of recorded) await claimsService.attach(actor, claimId, link.sourceId, 'SUPPORTS', link.evidenceId, link.digest);
              const finalPolicy = await claimsService.assessActive(actor, claimId);
              assert(finalPolicy.status === 'NEEDS_HUMAN_REVIEW', pack + ': final domain evidence still requires human review');
              const reviewedFinal = await claimsService.assess(actor, { claimId, capabilityId: capabilityByPack.get(pack) as ID, policyVersion: 1, reason: 'QA human review of final domain claim and captured evidence', reviewerDecision: 'SUPPORTED' });
              assert(reviewedFinal.status === 'SUPPORTED', pack + ': final domain claim requires explicit human assessment');
            }
          }
          state = await progression.complete(current.id as ID, { text: JSON.stringify(validated), sourceId, evidenceId, quality: 'UNVERIFIED', ...(finalStep.businessDeliverable ? { businessDeliverable: finalStep.businessDeliverable } : {}) }, 'UNVERIFIED');
        }
      }
      assert(state === 'AWAITING_REVIEW', pack + ': every plan step completed into AWAITING_REVIEW');
      const [approval] = await db.select().from(approvals).where(and(eq(approvals.operationId, operationId), eq(approvals.status, 'PENDING')));
      assert(approval && approval.payload.purpose === 'RESULT_REVIEW', pack + ': RESULT_REVIEW approval gate created');
      const doc = await assembler.assemble(actor, operationId, revisionId, projected.title, [...projected.scope], [...projected.nextActions]);
      assert(doc.status === 'READY_FOR_REVIEW', pack + ': result document READY_FOR_REVIEW');
      // Human review stays mandatory, beta or not.
      await expectDomainError('DENIED', () => new ResultDeliveryService(store, resolveCommercePolicy('BETA_FREE')).deliver(actor, operationId, doc.id, approval.id as ID), pack + ': delivery before the human RESULT_REVIEW approval');
      await controls.decideApproval(actor, approval.id as ID, 'APPROVED', operationId);
      return { documentId: doc.id as ID, approvalId: approval.id as ID };
    };

    let httpDelivered = false;
    for (const [pack, mission] of missionsA) {
      const review = await runToReview(tenantA.principal, pack, mission.operationId, mission.revisionId, 'qa-a2103-start-' + pack);
      let delivered: { status: string; operationStatus: string };
      if (!httpDelivered && !PUBLISHED[pack].free) {
        const response = await http(base, '/v1/operations/' + mission.operationId + '/documents/' + review.documentId + '/deliver', { headers: tenantA.headers, json: { approvalId: review.approvalId } });
        assert(response.status === 201, pack + ': delivered over HTTP (201) — got ' + String(response.status) + ' ' + JSON.stringify(response.body));
        delivered = response.body as unknown as { status: string; operationStatus: string };
        httpDelivered = true;
      } else {
        delivered = await new ResultDeliveryService(store, resolveCommercePolicy('BETA_FREE')).deliver(tenantA.principal, mission.operationId, review.documentId, review.approvalId);
      }
      assert(delivered.status === 'DELIVERABLE' && delivered.operationStatus === 'COMPLETED', pack + ': DELIVERABLE released and operation COMPLETED');
      const order = await orderOf(mission.orderId);
      const deliveredEvent = (await db.execute(sql`SELECT payload FROM operation_events WHERE operation_id = ${mission.operationId} AND kind = 'RESULT_DELIVERED'`)).rows[0] as { payload: { data: Record<string, unknown> } };
      if (PUBLISHED[pack].free) {
        assert(order.state === 'DELIVERED', pack + ': free order DELIVERED as before');
        assert(deliveredEvent.payload.data.commercialBasis === undefined, pack + ': free delivery event unchanged');
      } else {
        assert(order.state === 'BETA_DELIVERED', pack + ': priced order is BETA_DELIVERED (never DELIVERED, AUTHORIZED, PAID or CAPTURED)');
        const [row] = await betaRowsFor(mission.orderId);
        assert(row!.status === 'DELIVERED' && row!.deliveredAt instanceof Date && row!.amountDueNowMinor === 0, pack + ': beta authorization consumed by delivery, still 0 due');
        assert(deliveredEvent.payload.data.commercialBasis === 'FREE_BETA' && deliveredEvent.payload.data.betaAuthorizationId === row!.id, pack + ': RESULT_DELIVERED names the free-beta basis');
        const commercial = (await http(base, '/v1/operations/' + mission.operationId + '/commercial', { headers: tenantA.headers })).body as unknown as { executionAuthorized: boolean; betaAuthorization: { status: string; valid: boolean; denial: string | null } };
        assert(commercial.executionAuthorized === false && commercial.betaAuthorization.status === 'DELIVERED' && commercial.betaAuthorization.valid === false && commercial.betaAuthorization.denial === 'ALREADY_DELIVERED', pack + ': after delivery the authorization is reported consumed');
      }
      const deliverable = await db.select().from(resultDocuments).where(and(eq(resultDocuments.operationId, mission.operationId), eq(resultDocuments.state, 'DELIVERABLE')));
      assert(deliverable.length === 1, pack + ': exactly one DELIVERABLE document');
    }
    assert(JSON.stringify(await paymentFootprint()) === JSON.stringify({ p: 0, r: 0, e: 0 }), 'still no payment, refund or payment-event row after 8 deliveries');
    // A delivered beta order cannot be re-launched by redo: the authorization covered one delivery.
    const deliveredStrategy = missionsA.get('strategy')!;
    const [strategyAttempt] = await db.select().from(attempts).where(eq(attempts.operationId, deliveredStrategy.operationId)).limit(1);
    const strategyOp = await store.getOperation(tenantA.principal, deliveredStrategy.operationId);
    await expectDomainError('BETA_ACCESS_REQUIRED', () => controls.requestRedo(tenantA.principal, deliveredStrategy.operationId, strategyAttempt!.id as ID, strategyOp.version, 'qa-a2103-redo-delivered'), 'redo after a beta delivery', 'BETA_AUTHORIZATION_ALREADY_DELIVERED');
    pass('all 8 packs executed through the real ToolBroker and delivered after human review with NO payment rows: 6 priced orders BETA_DELIVERED, 2 free orders DELIVERED; one delivery over HTTP; redo after a beta delivery refused');

    // ── Group 4 · concurrent acceptance ──────────────────────────────────────────────────────────
    const tenantC = await register('tenant-concurrency');
    await seedQaBetaGrant(db, tenantC.workspaceId);
    const betaCommerce = new CommerceService(store, resolveCommercePolicy('BETA_FREE'));
    {
      const mission = await requestMission(tenantC, 'seo');
      const quote = await quoteOverHttp(tenantC, mission);
      const key = 'qa-a2103-replay-key-0001';
      const replays = await Promise.allSettled(Array.from({ length: 6 }, () => betaCommerce.accept(tenantC.principal, quote.id, key)));
      const fulfilled = replays.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<CommerceService['accept']>>> => r.status === 'fulfilled');
      assert(fulfilled.length === 6, 'six concurrent replays with the same actor and key all succeed — ' + JSON.stringify(replays.filter(r => r.status === 'rejected').map(r => String((r as PromiseRejectedResult).reason))));
      assert(new Set(fulfilled.map(r => r.value.orderId)).size === 1 && fulfilled.filter(r => !r.value.alreadyAccepted).length === 1, 'replays converge on one order, accepted once');
      assert(fulfilled.every(r => r.value.state === 'BETA_AUTHORIZED'), 'every replay reports BETA_AUTHORIZED');
      const orderId = fulfilled[0]!.value.orderId!;
      assert((await betaRowsFor(orderId)).length === 1 && (await db.select().from(quoteAcceptances).where(eq(quoteAcceptances.quoteId, quote.id))).length === 1, 'one acceptance and one beta authorization');
    }
    {
      const mission = await requestMission(tenantC, 'sales');
      const quote = await quoteOverHttp(tenantC, mission);
      const racers = await Promise.allSettled(Array.from({ length: 5 }, (_, index) => betaCommerce.accept(tenantC.principal, quote.id, 'qa-a2103-race-key-' + String(index) + '-' + randomUUID().slice(0, 6))));
      const won = racers.filter(r => r.status === 'fulfilled');
      const lost = racers.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      assert(won.length === 1 && lost.length === 4 && lost.every(r => r.reason instanceof DomainError && r.reason.code === 'CONFLICT'), 'five different keys racing on one quote: exactly one wins, four CONFLICT');
      const orders = await db.select().from(commercialOrders).where(eq(commercialOrders.operationId, mission.operationId));
      assert(orders.length === 1 && orders[0]!.state === 'BETA_AUTHORIZED' && (await betaRowsFor(orders[0]!.id)).length === 1, 'one order, one beta authorization');
    }
    {
      const mission = await requestMission(tenantC, 'content');
      const first = await quoteOverHttp(tenantC, mission);
      const second = await quoteOverHttp(tenantC, mission);
      const competing = await Promise.allSettled([betaCommerce.accept(tenantC.principal, first.id, 'qa-a2103-compete-a-' + randomUUID()), betaCommerce.accept(tenantC.principal, second.id, 'qa-a2103-compete-b-' + randomUUID())]);
      assert(competing.filter(r => r.status === 'fulfilled').length === 1 && competing.filter(r => r.status === 'rejected' && (r.reason as DomainError).code === 'CONFLICT').length === 1, 'two quotes of one revision accepted concurrently: one order, one CONFLICT');
      const authorizations = await db.select().from(betaExecutionAuthorizations).where(eq(betaExecutionAuthorizations.operationId, mission.operationId));
      assert(authorizations.length === 1, 'one beta authorization for the revision');
      const httpRetry = await acceptOverHttp(tenantC, mission, second.id);
      assert(httpRetry.status === 409 && codeOf(httpRetry) === 'CONFLICT', 'accepting the other quote afterwards over HTTP → 409 CONFLICT');
      assert((await db.select().from(commercialOrders).where(eq(commercialOrders.operationId, mission.operationId))).length === 1, 'still one order for the revision');
    }
    pass('concurrent acceptance: same-key replays converge, different keys and competing quotes produce exactly one order and one beta authorization; losers get CONFLICT');

    // ── Group 5 · revoked grant ─────────────────────────────────────────────────────────────────
    const betaStore = new BetaAccessStore(db);
    const revokeGrant = async (grantId: string, operatorUserId: string) => {
      const outcome = await betaStore.revokeGrant({
        grantId, actorUserId: operatorUserId, reason: 'QA A21.03 revocation of beta access', at: new Date(),
        buildAudit: grant => ({ id: randomUUID(), actorUserId: operatorUserId, actorSessionId: null, targetType: 'BETA_GRANT', targetId: grant.id, action: 'REVOKE_BETA_ACCESS', permission: 'ADMINISTRATION', outcome: 'SUCCESS', reason: 'QA A21.03 revocation', detail: null, happenedAt: new Date() }),
      });
      assert(outcome.outcome === 'REVOKED', 'grant revoked through BetaAccessStore.revokeGrant');
    };
    const tenantR = await register('tenant-revoked');
    const grantR = await seedQaBetaGrant(db, tenantR.workspaceId);
    {
      // R1: authorized, revoked BEFORE launch.
      const notStarted = await requestMission(tenantR, 'marketing');
      const q1 = await quoteOverHttp(tenantR, notStarted);
      assert(((await acceptOverHttp(tenantR, notStarted, q1.id)).body as { state?: string }).state === 'BETA_AUTHORIZED', 'revocation fixture: order BETA_AUTHORIZED');
      // R2: authorized and run to an approved review, then revoked BEFORE delivery.
      const reviewed = await requestMission(tenantR, 'seo');
      const q2 = await quoteOverHttp(tenantR, reviewed);
      const accepted2 = (await acceptOverHttp(tenantR, reviewed, q2.id)).body as unknown as { orderId: string };
      const review = await runToReview(tenantR.principal, 'seo', reviewed.operationId, reviewed.revisionId, 'qa-a2103-revoked-start');
      await revokeGrant(grantR.grantId, grantR.operatorUserId);
      const opBefore = await store.getOperation(tenantR.principal, notStarted.operationId);
      const denialsBefore = (await db.select().from(betaGrantEvents).where(and(eq(betaGrantEvents.workspaceId, tenantR.workspaceId), eq(betaGrantEvents.kind, 'LAUNCH_DENIED')))).length;
      await expectDomainError('BETA_ACCESS_REQUIRED', () => new OperationExecutionService(store, qaVerifiedRuntime).start(tenantR.principal, notStarted.operationId, opBefore.version, 'qa-a2103-revoked-launch'), 'start after revocation', 'BETA_AUTHORIZATION_GRANT_REVOKED');
      const denials = await db.select().from(betaGrantEvents).where(and(eq(betaGrantEvents.workspaceId, tenantR.workspaceId), eq(betaGrantEvents.kind, 'LAUNCH_DENIED')));
      assert(denials.length === denialsBefore + 1 && denials.some(e => e.reason === 'BETA_AUTHORIZATION_GRANT_REVOKED' && e.grantId === grantR.grantId), 'the refused launch is recorded in the beta ledger against the revoked grant');
      assert((await store.getOperation(tenantR.principal, notStarted.operationId)).status === 'READY', 'the refused launch changed nothing');
      const httpStart = await http(base, '/v1/operations/' + notStarted.operationId + '/start', { headers: tenantR.headers, json: { expectedVersion: opBefore.version, idempotencyKey: 'qa-a2103-revoked-http-start' } });
      assert(httpStart.status === 403 && codeOf(httpStart) === 'BETA_ACCESS_REQUIRED', 'HTTP start after revocation → 403 BETA_ACCESS_REQUIRED');
      const deliveryDenied = await http(base, '/v1/operations/' + reviewed.operationId + '/documents/' + review.documentId + '/deliver', { headers: tenantR.headers, json: { approvalId: review.approvalId } });
      assert(deliveryDenied.status === 403 && codeOf(deliveryDenied) === 'BETA_ACCESS_REQUIRED', 'HTTP delivery after revocation → 403 BETA_ACCESS_REQUIRED');
      await expectDomainError('BETA_ACCESS_REQUIRED', () => new ResultDeliveryService(store, resolveCommercePolicy('BETA_FREE')).deliver(tenantR.principal, reviewed.operationId, review.documentId, review.approvalId), 'in-process delivery after revocation', 'BETA_AUTHORIZATION_GRANT_REVOKED');
      assert((await store.getOperation(tenantR.principal, reviewed.operationId)).status === 'WAITING_APPROVAL' && (await orderOf(accepted2.orderId)).state === 'BETA_AUTHORIZED', 'refused delivery left the operation in review and the order BETA_AUTHORIZED');
      assert((await db.select().from(resultDocuments).where(and(eq(resultDocuments.operationId, reviewed.operationId), eq(resultDocuments.state, 'DELIVERABLE')))).length === 0, 'no DELIVERABLE document was released');
      const view = (await http(base, '/v1/operations/' + notStarted.operationId + '/commercial', { headers: tenantR.headers })).body as unknown as { executionAuthorized: boolean; betaAuthorization: { valid: boolean; denial: string } };
      assert(view.executionAuthorized === false && view.betaAuthorization.valid === false && view.betaAuthorization.denial === 'GRANT_REVOKED', 'GET commercial reports the authorization invalid (GRANT_REVOKED)');
      const readiness = await new PlanReadService(store, () => OPERATIONAL_RUNTIME, resolveCommercePolicy('BETA_FREE')).readiness(tenantR.principal, notStarted.operationId);
      assert(!readiness.canStart && readiness.blockers.some(b => b.code === 'BETA_AUTHORIZATION_INVALID' && b.detail.includes('GRANT_REVOKED')) && readiness.prerequisites.betaAuthorization.denial === 'GRANT_REVOKED', 'readiness blocks with BETA_AUTHORIZATION_INVALID (GRANT_REVOKED)');
      // A NEW grant does not revive an authorization linked to the revoked one.
      await seedQaBetaGrant(db, tenantR.workspaceId);
      const afterRegrant = (await http(base, '/v1/operations/' + notStarted.operationId + '/commercial', { headers: tenantR.headers })).body as unknown as { betaAuthorization: { valid: boolean; denial: string } };
      assert(afterRegrant.betaAuthorization.valid === false && afterRegrant.betaAuthorization.denial === 'GRANT_REVOKED', 'a later grant does not revive an authorization bound to a revoked grant');
      const opAgain = await store.getOperation(tenantR.principal, notStarted.operationId);
      await expectDomainError('BETA_ACCESS_REQUIRED', () => new OperationExecutionService(store, qaVerifiedRuntime).start(tenantR.principal, notStarted.operationId, opAgain.version, 'qa-a2103-regrant-launch'), 'start under a new grant with an authorization bound to the revoked grant', 'BETA_AUTHORIZATION_GRANT_REVOKED');
      // Retry of a failed beta mission: the new grant passes the A21.02 launch gate, so only the A21.03
      // authorization re-check (bound to the revoked grant) can refuse it — and it must.
      const reviewedOp = await store.getOperation(tenantR.principal, reviewed.operationId);
      await db.update(operations).set({ status: 'FAILED', payload: { ...reviewedOp, status: 'FAILED' } as never }).where(eq(operations.id, reviewed.operationId));
      const [someAttempt] = await db.select().from(attempts).where(eq(attempts.operationId, reviewed.operationId)).limit(1);
      await db.update(attempts).set({ state: 'FAILED', payload: { ...someAttempt!.payload, state: 'FAILED' } }).where(eq(attempts.id, someAttempt!.id));
      const retryOp = await store.getOperation(tenantR.principal, reviewed.operationId);
      await expectDomainError('BETA_ACCESS_REQUIRED', () => new InterruptionService(store).retry(tenantR.principal, reviewed.operationId, retryOp.version, 'qa-a2103-revoked-retry'), 'retry under a new grant of a mission authorized by the revoked grant', 'BETA_AUTHORIZATION_GRANT_REVOKED');
      assert((await store.getOperation(tenantR.principal, reviewed.operationId)).status === 'FAILED', 'the refused retry changed nothing');
    }
    {
      // No live grant: a priced acceptance stays PAYMENT_REQUIRED.
      const tenantNoGrant = await register('tenant-no-grant');
      const mission = await requestMission(tenantNoGrant, 'strategy');
      const quote = await quoteOverHttp(tenantNoGrant, mission);
      const accepted = (await acceptOverHttp(tenantNoGrant, mission, quote.id)).body as unknown as { orderId: string; state: string };
      assert(accepted.state === 'PAYMENT_REQUIRED' && (await betaRowsFor(accepted.orderId)).length === 0, 'BETA_FREE without a grant: priced acceptance stays PAYMENT_REQUIRED, no beta authorization');
      const readiness = await new PlanReadService(store, () => OPERATIONAL_RUNTIME, resolveCommercePolicy('BETA_FREE')).readiness(tenantNoGrant.principal, mission.operationId);
      assert(!readiness.canStart && readiness.blockers.some(b => b.code === 'PAYMENTS_FROZEN'), 'readiness keeps the PAYMENTS_FROZEN blocker without a grant');
    }
    pass('revoked grant: start (in-process and HTTP), retry and delivery refused with BETA_ACCESS_REQUIRED and ledgered; nothing released; views report GRANT_REVOKED; a new grant does not revive it');

    // ── Group 6 · expired grant ─────────────────────────────────────────────────────────────────
    const tenantE = await register('tenant-expired');
    const grantE = await seedQaBetaGrant(db, tenantE.workspaceId);
    {
      const notStarted = await requestMission(tenantE, 'financial-analysis');
      const q1 = await quoteOverHttp(tenantE, notStarted);
      assert(((await acceptOverHttp(tenantE, notStarted, q1.id)).body as { state?: string }).state === 'BETA_AUTHORIZED', 'expiry fixture: order BETA_AUTHORIZED');
      const reviewed = await requestMission(tenantE, 'content');
      const q2 = await quoteOverHttp(tenantE, reviewed);
      (await acceptOverHttp(tenantE, reviewed, q2.id));
      const review = await runToReview(tenantE.principal, 'content', reviewed.operationId, reviewed.revisionId, 'qa-a2103-expired-start');
      // Fixture shortcut: move the stored expiry into the past (the code reads the real clock).
      await db.execute(sql`UPDATE beta_grants SET expires_at = created_at + interval '1 millisecond' WHERE id = ${grantE.grantId}`);
      const [stored] = await db.select().from(betaGrants).where(eq(betaGrants.id, grantE.grantId));
      assert(stored!.status === 'ACTIVE' && stored!.expiresAt.getTime() < Date.now(), 'grant still stored ACTIVE but past its expiry');
      const op = await store.getOperation(tenantE.principal, notStarted.operationId);
      await expectDomainError('BETA_ACCESS_REQUIRED', () => new OperationExecutionService(store, qaVerifiedRuntime).start(tenantE.principal, notStarted.operationId, op.version, 'qa-a2103-expired-launch'), 'start after expiry', 'BETA_AUTHORIZATION_GRANT_EXPIRED');
      await expectDomainError('BETA_ACCESS_REQUIRED', () => new ResultDeliveryService(store, resolveCommercePolicy('BETA_FREE')).deliver(tenantE.principal, reviewed.operationId, review.documentId, review.approvalId), 'delivery after expiry', 'BETA_AUTHORIZATION_GRANT_EXPIRED');
      assert((await db.select().from(resultDocuments).where(and(eq(resultDocuments.operationId, reviewed.operationId), eq(resultDocuments.state, 'DELIVERABLE')))).length === 0, 'no DELIVERABLE document after an expired grant');
      const view = (await http(base, '/v1/operations/' + notStarted.operationId + '/commercial', { headers: tenantE.headers })).body as unknown as { executionAuthorized: boolean; betaAuthorization: { valid: boolean; denial: string } };
      assert(view.executionAuthorized === false && view.betaAuthorization.denial === 'GRANT_EXPIRED', 'GET commercial reports GRANT_EXPIRED');
      const readiness = await new PlanReadService(store, () => OPERATIONAL_RUNTIME, resolveCommercePolicy('BETA_FREE')).readiness(tenantE.principal, notStarted.operationId);
      assert(!readiness.canStart && readiness.blockers.some(b => b.code === 'BETA_AUTHORIZATION_INVALID' && b.detail.includes('GRANT_EXPIRED')), 'readiness blocks with BETA_AUTHORIZATION_INVALID (GRANT_EXPIRED)');
      const another = await requestMission(tenantE, 'sales');
      const q3 = await quoteOverHttp(tenantE, another);
      assert(((await acceptOverHttp(tenantE, another, q3.id)).body as { state?: string }).state === 'PAYMENT_REQUIRED', 'acceptance after expiry stays PAYMENT_REQUIRED');
    }
    pass('expired grant (stored ACTIVE, past expiry): start and delivery refused, nothing released, views and readiness report GRANT_EXPIRED, new acceptances stay PAYMENT_REQUIRED');

    // ── Group 7 · changed plan and tampered bindings ─────────────────────────────────────────────
    const tenantP = await register('tenant-plan');
    await seedQaBetaGrant(db, tenantP.workspaceId);
    {
      const mission = await requestMission(tenantP, 'strategy');
      const quote = await quoteOverHttp(tenantP, mission);
      const staleQuote = await quoteOverHttp(tenantP, mission);
      const accepted = (await acceptOverHttp(tenantP, mission, quote.id)).body as unknown as { orderId: string; state: string };
      assert(accepted.state === 'BETA_AUTHORIZED', 'plan fixture: order BETA_AUTHORIZED on revision 1');
      const op = await store.getOperation(tenantP.principal, mission.operationId);
      const steps = await store.getSteps(mission.revisionId);
      const index = new Map(steps.map((step, position) => [step.id, position]));
      const revised = await new PlanRevisionService(store).revise(tenantP.principal, mission.operationId, mission.revisionId, op.version, 'QA A21.03 customer changed the plan', steps.map(step => ({
        title: step.title, description: step.description + ' (revised scope)', capabilityId: step.capabilityId, intent: step.intent, dependsOnIndices: step.dependsOn.map(id => index.get(id)!),
      })));
      const opAfter = await store.getOperation(tenantP.principal, mission.operationId);
      assert(opAfter.currentRevisionId === revised.revision.id && revised.revision.id !== mission.revisionId, 'plan revised to a new revision');
      await expectDomainError('PAYMENT_REQUIRED', () => new OperationExecutionService(store, qaVerifiedRuntime).start(tenantP.principal, mission.operationId, opAfter.version, 'qa-a2103-revised-launch'), 'start after the plan changed (revision-1 authorization does not carry over)');
      await expectDomainError('CONFLICT', () => betaCommerce.accept(tenantP.principal, staleQuote.id, 'qa-a2103-stale-quote'), 'accepting a quote of the superseded revision');
      const view = (await http(base, '/v1/operations/' + mission.operationId + '/commercial', { headers: tenantP.headers })).body as unknown as { revisionId: string; order: unknown; executionAuthorized: boolean; betaAuthorization: unknown };
      assert(view.revisionId === revised.revision.id && view.order === null && view.executionAuthorized === false && view.betaAuthorization === null, 'GET commercial for the new revision shows no order and no authorization');
      const authorizer = new BetaExecutionAuthorizer(resolveCommercePolicy('BETA_FREE'));
      const oldOrder = await orderOf(accepted.orderId);
      const stale = await authorizer.evaluate(db, { order: oldOrder, currentRevisionId: revised.revision.id, at: new Date(), purpose: 'EXECUTION' });
      assert(!stale.ok && stale.denial === 'REVISION_CHANGED', 'the revision-1 authorization evaluates REVISION_CHANGED against the current revision');
      const [oldRow] = await betaRowsFor(accepted.orderId);
      assert(oldRow!.revisionId === mission.revisionId && oldRow!.status === 'AUTHORIZED', 'the revision-1 authorization is preserved untouched');
      const newQuote = await quoteOverHttp(tenantP, { operationId: mission.operationId, revisionId: revised.revision.id as ID, offerId: mission.offerId });
      assert(newQuote.scopeHash !== quote.scopeHash && newQuote.amountMinor === PUBLISHED.strategy.amountMinor, 'the new revision gets a new scope hash at the same published price');
      const reaccepted = (await acceptOverHttp(tenantP, mission, newQuote.id)).body as unknown as { orderId: string; state: string };
      const [newRow] = await betaRowsFor(reaccepted.orderId);
      assert(reaccepted.state === 'BETA_AUTHORIZED' && newRow!.revisionId === revised.revision.id && newRow!.scopeHash === newQuote.scopeHash, 'a new acceptance creates a new authorization bound to the new revision and scope');
      // Tampering: a binding that no longer matches the accepted quote is refused.
      await db.update(betaExecutionAuthorizations).set({ scopeHash: 'tampered-' + newRow!.scopeHash }).where(eq(betaExecutionAuthorizations.id, newRow!.id));
      await expectDomainError('BETA_ACCESS_REQUIRED', () => new OperationExecutionService(store, qaVerifiedRuntime).start(tenantP.principal, mission.operationId, opAfter.version, 'qa-a2103-tampered-launch'), 'start with a tampered scope hash', 'BETA_AUTHORIZATION_SCOPE_CHANGED');
      await db.update(betaExecutionAuthorizations).set({ scopeHash: newRow!.scopeHash }).where(eq(betaExecutionAuthorizations.id, newRow!.id));
      await db.update(betaExecutionAuthorizations).set({ listAmountMinor: 1 }).where(eq(betaExecutionAuthorizations.id, newRow!.id));
      await expectDomainError('BETA_ACCESS_REQUIRED', () => new OperationExecutionService(store, qaVerifiedRuntime).start(tenantP.principal, mission.operationId, opAfter.version, 'qa-a2103-tampered-price'), 'start with a tampered list price', 'BETA_AUTHORIZATION_AUTHORIZATION_MISMATCH');
      await db.update(betaExecutionAuthorizations).set({ listAmountMinor: newRow!.listAmountMinor }).where(eq(betaExecutionAuthorizations.id, newRow!.id));
      let rejected = false;
      try { await db.update(betaExecutionAuthorizations).set({ amountDueNowMinor: 100 }).where(eq(betaExecutionAuthorizations.id, newRow!.id)); } catch { rejected = true; }
      assert(rejected, 'the database refuses a non-zero amount due now (CHECK raas_beta_authorizations_amount_due_zero)');
      const launched = await new OperationExecutionService(store, qaVerifiedRuntime).start(tenantP.principal, mission.operationId, opAfter.version, 'qa-a2103-revised-ok');
      assert(!launched.alreadyAccepted && (await store.getOperation(tenantP.principal, mission.operationId)).status === 'RUNNING', 'with intact bindings the new revision launches');
    }
    pass('changed plan: the old authorization does not carry over (REVISION_CHANGED), stale quotes CONFLICT, the new revision needs a new acceptance and gets a new bound authorization; tampered scope/price refused; DB refuses amount due ≠ 0');

    // ── Group 8 · cross-tenant ──────────────────────────────────────────────────────────────────
    const tenantB = await register('tenant-b');
    {
      const target = await requestMission(tenantA, 'marketing');
      const quote = await quoteOverHttp(tenantA, target);
      const readB = await http(base, '/v1/operations/' + target.operationId + '/commercial', { headers: tenantB.headers });
      assert(readB.status === 404, 'tenant B cannot read tenant A commercial state (404)');
      const acceptB = await acceptOverHttp(tenantB, target, quote.id);
      assert(acceptB.status === 404, 'tenant B cannot accept tenant A quote (404)');
      await expectDomainError('NOT_FOUND', () => betaCommerce.accept(tenantB.principal, quote.id, 'qa-a2103-cross-accept'), 'in-process cross-tenant accept');
      const betaB = await http(base, '/v1/operations/' + target.operationId + '/commercial/beta-authorization', { headers: tenantB.headers, json: {} });
      assert(betaB.status === 404, 'tenant B cannot beta-authorize tenant A operation (404)');
      const accepted = (await acceptOverHttp(tenantA, target, quote.id)).body as unknown as { orderId: string; state: string };
      assert(accepted.state === 'BETA_AUTHORIZED', 'tenant A accepts its own quote (BETA_AUTHORIZED)');
      const opA = await store.getOperation(tenantA.principal, target.operationId);
      await expectDomainError('NOT_FOUND', () => new OperationExecutionService(store, qaVerifiedRuntime).start(tenantB.principal, target.operationId, opA.version, 'qa-a2103-cross-start'), 'tenant B cannot start tenant A beta mission');
      await expectDomainError('NOT_FOUND', () => betaCommerce.assertExecutionAllowed(tenantB.principal, target.operationId, target.revisionId), 'tenant B cannot probe tenant A execution authorization');
      const paymentB = await http(base, '/v1/operations/' + target.operationId + '/payment', { headers: tenantB.headers });
      assert(paymentB.status === 404, 'tenant B cannot read tenant A payment view (404)');
      // Tenant A's grant never covers tenant B: B has no grant, so B's priced acceptance needs payment.
      const missionB = await requestMission(tenantB, 'marketing');
      const quoteB = await quoteOverHttp(tenantB, missionB);
      const acceptedB = (await acceptOverHttp(tenantB, missionB, quoteB.id)).body as unknown as { orderId: string; state: string };
      assert(acceptedB.state === 'PAYMENT_REQUIRED' && (await betaRowsFor(acceptedB.orderId)).length === 0, 'tenant B (no grant) is not covered by tenant A grant: PAYMENT_REQUIRED');
      const convertB = await http(base, '/v1/operations/' + missionB.operationId + '/commercial/beta-authorization', { headers: tenantB.headers, json: {} });
      assert(convertB.status === 403 && codeOf(convertB) === 'BETA_ACCESS_REQUIRED', 'tenant B cannot convert without its own grant (403)');
      // A forged authorization row pointing at another workspace's grant is refused by evaluation.
      const authorizer = new BetaExecutionAuthorizer(resolveCommercePolicy('BETA_FREE'));
      const forged = await authorizer.evaluate(db, { order: { ...(await orderOf(accepted.orderId)), workspaceId: tenantB.workspaceId }, currentRevisionId: target.revisionId, at: new Date(), purpose: 'EXECUTION' });
      assert(!forged.ok && forged.denial === 'AUTHORIZATION_MISSING', 'an order presented under another workspace finds no authorization');
    }
    pass('cross-tenant: no read, accept, beta-authorize, start, probe or payment read across workspaces; one workspace grant never covers another');

    // ── Group 9 · explicit conversion of an order accepted before the grant ──────────────────────
    const tenantV = await register('tenant-convert');
    {
      const mission = await requestMission(tenantV, 'seo');
      const quote = await quoteOverHttp(tenantV, mission);
      const accepted = (await acceptOverHttp(tenantV, mission, quote.id)).body as unknown as { orderId: string; state: string };
      assert(accepted.state === 'PAYMENT_REQUIRED', 'accepted before any grant: PAYMENT_REQUIRED');
      const before = (await http(base, '/v1/operations/' + mission.operationId + '/commercial', { headers: tenantV.headers })).body as unknown as { betaAuthorizationAvailable: boolean };
      assert(before.betaAuthorizationAvailable === false, 'no grant: conversion not offered');
      const noGrant = await http(base, '/v1/operations/' + mission.operationId + '/commercial/beta-authorization', { headers: tenantV.headers, json: {} });
      assert(noGrant.status === 403 && codeOf(noGrant) === 'BETA_ACCESS_REQUIRED', 'conversion without a grant → 403 BETA_ACCESS_REQUIRED');
      await seedQaBetaGrant(db, tenantV.workspaceId);
      const offered = (await http(base, '/v1/operations/' + mission.operationId + '/commercial', { headers: tenantV.headers })).body as unknown as { betaAuthorizationAvailable: boolean; executionAuthorized: boolean };
      assert(offered.betaAuthorizationAvailable === true && offered.executionAuthorized === false, 'with an active grant: conversion offered, execution not yet authorized');
      const readiness = await new PlanReadService(store, () => OPERATIONAL_RUNTIME, resolveCommercePolicy('BETA_FREE')).readiness(tenantV.principal, mission.operationId);
      assert(!readiness.canStart && readiness.blockers.some(b => b.code === 'BETA_AUTHORIZATION_AVAILABLE'), 'readiness names BETA_AUTHORIZATION_AVAILABLE');
      const converted = await http(base, '/v1/operations/' + mission.operationId + '/commercial/beta-authorization', { headers: tenantV.headers, json: {} });
      const body = converted.body as unknown as { orderId: string; state: string; alreadyAuthorized: boolean; betaAuthorizationId: string };
      assert(converted.status === 201 && body.state === 'BETA_AUTHORIZED' && body.alreadyAuthorized === false && body.orderId === accepted.orderId, 'POST beta-authorization converts the order (201)');
      const [row] = await betaRowsFor(accepted.orderId);
      const order = await orderOf(accepted.orderId);
      assert(row!.id === body.betaAuthorizationId && row!.listAmountMinor === PUBLISHED.seo.amountMinor && row!.amountDueNowMinor === 0 && order.amountMinor === PUBLISHED.seo.amountMinor && order.quoteId === quote.id, 'conversion keeps quote and price; 0 due');
      const again = await http(base, '/v1/operations/' + mission.operationId + '/commercial/beta-authorization', { headers: tenantV.headers, json: {} });
      assert(again.status === 201 && (again.body as { alreadyAuthorized?: boolean }).alreadyAuthorized === true && (await betaRowsFor(accepted.orderId)).length === 1, 'conversion is idempotent');
      // Free offers and orders with payment history are never converted.
      const freeMission = await requestMission(tenantV, 'research');
      const freeQuote = await quoteOverHttp(tenantV, freeMission);
      await acceptOverHttp(tenantV, freeMission, freeQuote.id);
      const freeConvert = await http(base, '/v1/operations/' + freeMission.operationId + '/commercial/beta-authorization', { headers: tenantV.headers, json: {} });
      assert(freeConvert.status === 409 && codeOf(freeConvert) === 'INVALID_STATE', 'an AUTHORIZED free order is not converted (409 INVALID_STATE)');
      assert(JSON.stringify(await paymentFootprint()) === JSON.stringify({ p: 0, r: 0, e: 0 }), 'still no payment rows before the payment-history fixture');
      const withHistory = await requestMission(legacy, 'sales');
      const historyQuote = await disabledCommerce.quote(legacy.principal, withHistory.operationId, withHistory.offerId, withHistory.revisionId) as { id: ID };
      const historyOrder = await disabledCommerce.accept(legacy.principal, historyQuote.id, 'qa-a2103-history-accept');
      const now = new Date().toISOString();
      // Fixture: a historical (pre-freeze) failed payment attempt on that order.
      await db.insert(payments).values({ id: randomUUID(), workspaceId: legacy.workspaceId, operationId: withHistory.operationId, orderId: historyOrder.orderId!, status: 'FAILED', amountMinor: PUBLISHED.sales.amountMinor, currency: 'EUR', idempotencyKey: 'qa-a2103-history-' + randomUUID(), createdAt: now, updatedAt: now });
      await expectDomainError('CONFLICT', () => betaCommerce.authorizeBeta(legacy.principal, withHistory.operationId), 'conversion of an order with payment history');
      assert((await orderOf(historyOrder.orderId!)).state === 'PAYMENT_REQUIRED' && (await betaRowsFor(historyOrder.orderId!)).length === 0, 'the order with payment history is untouched');
    }
    pass('explicit conversion: a PAYMENT_REQUIRED order accepted before the grant is converted (idempotent) only with an active grant; free orders and orders with payment history are refused');

    // ── Group 10 · back to PAYMENTS_DISABLED: existing beta authorizations stop authorizing ───────
    {
      const mission = await requestMission(tenantC, 'financial-analysis');
      const quote = await quoteOverHttp(tenantC, mission);
      const accepted = (await acceptOverHttp(tenantC, mission, quote.id)).body as unknown as { orderId: string; state: string };
      assert(accepted.state === 'BETA_AUTHORIZED', 'mode fixture: BETA_AUTHORIZED under BETA_FREE');
      process.env.QEYNOX_COMMERCE_MODE = 'PAYMENTS_DISABLED';
      const op = await store.getOperation(tenantC.principal, mission.operationId);
      await expectDomainError('BETA_ACCESS_REQUIRED', () => new OperationExecutionService(store, qaVerifiedRuntime).start(tenantC.principal, mission.operationId, op.version, 'qa-a2103-disabled-launch'), 'start of a beta order under PAYMENTS_DISABLED', 'BETA_AUTHORIZATION_BETA_MODE_DISABLED');
      const view = await new CommerceService(store).view(tenantC.principal, mission.operationId);
      assert(view.executionAuthorized === false && view.betaAuthorization?.denial === 'BETA_MODE_DISABLED', 'commercial view under PAYMENTS_DISABLED: authorization suspended');
      const readiness = await new PlanReadService(store, () => OPERATIONAL_RUNTIME).readiness(tenantC.principal, mission.operationId);
      assert(!readiness.canStart && readiness.blockers.some(b => b.code === 'BETA_AUTHORIZATION_INVALID' && b.detail.includes('BETA_MODE_DISABLED')), 'readiness under PAYMENTS_DISABLED: BETA_AUTHORIZATION_INVALID');
      process.env.QEYNOX_COMMERCE_MODE = 'BETA_FREE';
      const relaunch = await new OperationExecutionService(store, qaVerifiedRuntime).start(tenantC.principal, mission.operationId, op.version, 'qa-a2103-reenabled-launch');
      assert(!relaunch.alreadyAccepted, 'back in BETA_FREE the same authorization launches again');
    }
    pass('mode switched to PAYMENTS_DISABLED: existing beta authorizations stop authorizing execution (fail closed) and resume in BETA_FREE');

    // ── Group 11 · mandatory controls are not bypassed ───────────────────────────────────────────
    {
      // Beta mission quota (A21.02) still applies to beta-authorized orders.
      const tenantQ = await register('tenant-quota');
      await seedQaBetaGrant(db, tenantQ.workspaceId, { missionQuota: 1 });
      const first = await requestMission(tenantQ, 'strategy');
      const second = await requestMission(tenantQ, 'content');
      for (const mission of [first, second]) {
        const quote = await quoteOverHttp(tenantQ, mission);
        assert(((await acceptOverHttp(tenantQ, mission, quote.id)).body as { state?: string }).state === 'BETA_AUTHORIZED', 'quota fixture: BETA_AUTHORIZED');
      }
      await new OperationExecutionService(store, qaVerifiedRuntime).start(tenantQ.principal, first.operationId, (await store.getOperation(tenantQ.principal, first.operationId)).version, 'qa-a2103-quota-1');
      const secondOp = await store.getOperation(tenantQ.principal, second.operationId);
      await expectDomainError('BETA_LIMIT_REACHED', () => new OperationExecutionService(store, qaVerifiedRuntime).start(tenantQ.principal, second.operationId, secondOp.version, 'qa-a2103-quota-2'), 'second beta mission beyond the mission quota', 'MISSION_QUOTA_REACHED');
      // Budget: a beta-authorized order without a workspace budget policy cannot start.
      const tenantNoBudget = await register('tenant-no-budget', { budget: false });
      await seedQaBetaGrant(db, tenantNoBudget.workspaceId);
      const mission = await requestMission(tenantNoBudget, 'sales');
      const quote = await quoteOverHttp(tenantNoBudget, mission);
      assert(((await acceptOverHttp(tenantNoBudget, mission, quote.id)).body as { state?: string }).state === 'BETA_AUTHORIZED', 'budget fixture: BETA_AUTHORIZED');
      const noBudgetOp = await store.getOperation(tenantNoBudget.principal, mission.operationId);
      await expectDomainError('NOT_CONFIGURED', () => new OperationExecutionService(store, qaVerifiedRuntime).start(tenantNoBudget.principal, mission.operationId, noBudgetOp.version, 'qa-a2103-no-budget'), 'beta order without a budget policy');
      const readiness = await new PlanReadService(store, () => OPERATIONAL_RUNTIME, resolveCommercePolicy('BETA_FREE')).readiness(tenantNoBudget.principal, mission.operationId);
      assert(!readiness.canStart && readiness.blockers.some(b => b.code === 'BUDGET_NOT_CONFIGURED'), 'readiness: BUDGET_NOT_CONFIGURED despite a valid beta authorization');
      // ToolBroker allowlist and consent: a launched beta mission still needs them.
      const running: { operationId: ID; revisionId: ID; offerId: string } | undefined = await requestMission(tenantA, 'seo');
      const quoteRun = await quoteOverHttp(tenantA, running!);
      await acceptOverHttp(tenantA, running!, quoteRun.id);
      await new OperationExecutionService(store, qaVerifiedRuntime).start(tenantA.principal, running!.operationId, (await store.getOperation(tenantA.principal, running!.operationId)).version, 'qa-a2103-broker-start');
      const [attempt] = await db.select().from(attempts).where(and(eq(attempts.operationId, running!.operationId), eq(attempts.state, 'PENDING')));
      const attemptId = attempt!.id as ID;
      await expectDomainError('DENIED', () => broker.invoke(callFor('seo', running!.operationId, running!.revisionId, attemptId), permissionFor(tenantA.principal, 'seo', running!.operationId, running!.revisionId, attemptId, { consentScopes: [] })), 'tool call without consent on a beta mission');
      await expectDomainError('DENIED', () => broker.invoke(callFor('seo', running!.operationId, running!.revisionId, attemptId), permissionFor(tenantA.principal, 'seo', running!.operationId, running!.revisionId, attemptId, { allowedConnectorTools: [] })), 'tool call outside the profile allowlist on a beta mission');
      await expectDomainError('DENIED', () => broker.invoke(callFor('seo', running!.operationId, running!.revisionId, attemptId), permissionFor(tenantA.principal, 'seo', running!.operationId, running!.revisionId, attemptId, { remainingToolCalls: 0 })), 'tool call without tool budget on a beta mission');
    }
    pass('mandatory controls intact for beta orders: mission quota/concurrency, budget policy, ToolBroker consent/allowlist/tool budget, runtime readiness and human RESULT_REVIEW (groups 2-3)');

    // ── Group 12 · global invariant ─────────────────────────────────────────────────────────────
    {
      const betaOrders = await db.select().from(commercialOrders).where(inArray(commercialOrders.state, ['BETA_AUTHORIZED', 'BETA_DELIVERED']));
      const betaIds = betaOrders.map(order => order.id);
      assert(betaOrders.length >= 15, 'the run produced ' + String(betaOrders.length) + ' beta orders');
      const authorizationRows = await db.select().from(betaExecutionAuthorizations);
      assert(betaIds.every(id => authorizationRows.some(row => row.orderId === id)), 'every beta order has exactly its beta authorization');
      assert(authorizationRows.every(row => row.amountDueNowMinor === 0 && row.listAmountMinor > 0), 'every beta authorization is priced and 0 due');
      assert((await db.select().from(payments).where(inArray(payments.orderId, betaIds))).length === 0, 'no payment row for any beta order');
      assert((await db.select().from(paymentEvents).where(inArray(paymentEvents.orderId, betaIds))).length === 0, 'no payment event for any beta order');
      assert((await db.select().from(refunds)).length === 0, 'no refund row at all');
      const authorizedOrders = await db.select().from(commercialOrders).where(inArray(commercialOrders.id, authorizationRows.map(row => row.orderId)));
      assert(authorizedOrders.every(order => order.state === 'BETA_AUTHORIZED' || order.state === 'BETA_DELIVERED'), 'no beta-authorized order is in AUTHORIZED, DELIVERED, PAID or CAPTURED');
      const paid = await db.execute(sql`SELECT count(*)::int AS n FROM raas_orders WHERE state IN ('PAID', 'CAPTURED')`);
      assert((paid.rows[0] as { n: number }).n === 0, 'no order anywhere is PAID or CAPTURED');
    }
    pass('global invariant: every beta order has its own non-financial authorization; zero payments, payment events or refunds for beta orders; no order is PAID/CAPTURED');

    console.log('Beta execution QA PASSED: ' + String(groups) + ' groups, ' + String(assertions) + ' assertions in ' + String(Math.round((Date.now() - startedAt) / 1000)) + 's');
    console.log('BOUNDARY: real PostgreSQL, real services, real HTTP API and real ToolBroker/PgToolLedger; no worker, Hermes, orchestrator or external provider ran (local provider fakes); expiry uses a stored-timestamp shortcut; no browser ran.');
  } catch (error: unknown) {
    process.exitCode = 1;
    console.error('Beta execution QA FAILED after ' + String(assertions) + ' assertions:', error instanceof Error ? error.stack ?? error.message : error);
  } finally {
    await runtime?.stop().catch(() => undefined);
    await app?.close().catch(() => undefined);
    await connection?.pool.end().catch(() => undefined);
    await qa.drop().then(() => console.log('QA database dropped: ' + qa.name)).catch(error => console.error('QA database drop failed:', error));
  }
}

await main();

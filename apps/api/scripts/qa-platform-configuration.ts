/**
 * Platform configuration end-to-end QA (isolated PostgreSQL only).
 *
 * Requires QEYNOX_QA_DATABASE_URL pointing at a disposable local PostgreSQL role. It creates a
 * brand-new database, applies every migration, seeds platform administrators directly (there is
 * no web self-service assignment) and boots the real NestJS API to exercise the Control-facing
 * operator configuration routes:
 *
 *   GET  /v1/platform/configuration?workspaceId=…  (CONSULTATION)
 *   POST /v1/platform/configuration/preview        (ADMINISTRATION, dry run)
 *   POST /v1/platform/configuration/apply          (ADMINISTRATION)
 *
 * Core guarantees tested here:
 * - platform permission split: reads need CONSULTATION, mutations need ADMINISTRATION;
 * - the operator engine gate still holds on mutations (QEYNOX_OPERATOR_USER_IDS + an ACTIVE
 *   OWNER/ADMIN/OPERATOR membership in the target workspace), and fails closed when unset;
 * - a platform session never becomes a workspace session;
 * - previews compute outcomes without persisting; applies are idempotency guarded and immutable
 *   by version; ACTIVE offers require taxPolicy=CONFIGURED (the tax gate);
 * - every success and every denial lands in the append-only platform audit trail, and the apply
 *   audit row commits inside the same transaction as the configuration mutation.
 *
 * BLOCKED (not PASS) when QEYNOX_QA_DATABASE_URL is absent.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { and, count, eq } from 'drizzle-orm';
import {
  connectDatabase,
  identityCredentials,
  identityMemberships,
  identityUsers,
  platformAdminAssignments,
  platformAdminAudit,
  runMigrations,
  configurationRecords,
} from '@qeynox/persistence';
import { hashPassword } from '../src/auth/password';
import { AppModule } from '../src/app.module';
import { DomainExceptionFilter } from '../src/transport/domain-exception.filter';
import { createIsolatedQaDatabase } from './qa-isolated-database';

let assertions = 0;
function assert(condition: unknown, message: string): asserts condition {
  assertions++;
  if (!condition) throw new Error('ASSERTION FAILED: ' + message);
}

interface HttpResult { readonly status: number; readonly body: unknown }

async function call(base: string, path: string, init: RequestInit = {}): Promise<HttpResult> {
  const response = await fetch(base + path, init);
  const text = await response.text();
  let body: unknown = text;
  try { body = JSON.parse(text) as unknown; } catch { /* plain text body */ }
  return { status: response.status, body };
}
function postJson(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}
function bearer(token: string): Record<string, string> {
  return { authorization: 'Bearer ' + token, 'content-type': 'application/json' };
}
function errorCode(result: HttpResult): string | undefined {
  return (result.body as { error?: { code?: string } }).error?.code;
}
interface ApplyResult { dryRun?: boolean; alreadyApplied?: boolean; digest?: string; changes?: Array<{ domain: string; key: string; version: number | string; outcome: string }> }

const password = 'platform-config-qa-passphrase';
const cfgAdmin = { userId: 'qa-config-admin', email: 'qa-config-admin@example.invalid' };
const auditor = { userId: 'qa-config-auditor', email: 'qa-config-auditor@example.invalid' };
const support = { userId: 'qa-config-support', email: 'qa-config-support@example.invalid' };
const operations = { userId: 'qa-config-operations', email: 'qa-config-operations@example.invalid' };

const seedAssignments: ReadonlyArray<readonly [string, string]> = [
  [cfgAdmin.userId, 'PLATFORM_ADMIN'],
  [auditor.userId, 'AUDITOR'],
  [support.userId, 'SUPPORT'],
  [operations.userId, 'OPERATIONS'],
];

const toolEntry = {
  domain: 'TOOL', connectorId: 'qa-invoice', version: '1.0.0', status: 'ACTIVE',
  manifest: {
    description: 'Deterministic QA invoice connector for the platform configuration suite',
    provider: 'QA Systems',
    regions: ['eu-west-1'],
    operations: ['read'],
    mode: 'READ_ONLY',
    licenseNotes: 'QA fixture license notes; not a commercial offering',
    freshness: { ttlSeconds: 3600, publishedAtSource: 'PROVIDER' },
    rateLimit: { maxPerMinute: 60 },
    tools: [{ name: 'fetch_invoice', version: '1.0.0' }],
  },
};
const capabilityEntry = {
  domain: 'BUSINESS_CAPABILITY', slot: 3, version: 1, status: 'ACTIVE',
  name: 'QA Claims Verification',
  purpose: 'Deterministic capability used by the platform configuration QA suite',
  scope: ['claims'],
  allowedTools: ['qa-invoice:fetch_invoice@1.0.0'],
  privacyScopes: [],
  inputSchemaVersion: 1, outputSchemaVersion: 1, maximumSteps: 4, maximumToolCalls: 8,
};
const verificationEntry = {
  domain: 'VERIFICATION_POLICY', capabilityId: 'capability-slot-3-v1', version: 1, status: 'ACTIVE',
  minimumSources: 2, maxAgeDays: 30, approvedProviders: ['qa-invoice'], humanReviewRequired: true,
  validFrom: '2026-01-01T00:00:00.000Z',
};
const offerEntry = (overrides: Record<string, unknown> = {}) => ({
  domain: 'RAAS_OFFER', offerId: 'qa-offer-standard', version: 1, status: 'ACTIVE',
  label: 'QA Standard Offer', capabilityIds: ['capability-slot-3-v1'],
  deliverableSchemaVersion: 1, scope: ['claims-qa'], exclusions: [], regions: ['EU'], locales: ['en-US'],
  termsVersion: 'qa-2026-01', currency: 'EUR', amountMinor: 10000,
  taxPolicy: 'CONFIG_REQUIRED', isExplicitlyFree: false, ...overrides,
});
const budgetEntry = (version: number) => ({
  domain: 'BUDGET_POLICY', policyId: 'qa-budget', version, status: 'ACTIVE',
  currency: 'EUR', maxMoneyMinor: 50000, maxAgentCalls: 1000, maxToolCalls: 10000,
  maxDurationSeconds: 3600, maxConcurrent: 5, unitMaxMinor: { hermes: 100 },
});

async function seedPlatformAccounts(databaseUrl: string): Promise<void> {
  const connection = connectDatabase(databaseUrl);
  try {
    const db = connection.db;
    const credential = await hashPassword(password);
    for (const account of [cfgAdmin, auditor, support, operations]) {
      await db.insert(identityUsers).values({ id: account.userId, email: account.email, locale: 'en' });
      await db.insert(identityCredentials).values({ userId: account.userId, salt: credential.salt, passwordHash: credential.hash });
    }
    for (const [userId, role] of seedAssignments) {
      await db.insert(platformAdminAssignments).values({
        id: randomUUID(), userId, role, status: 'ACTIVE', grantedBy: 'QA_FIXTURE',
        grantReason: 'deterministic platform configuration seed',
      });
    }
  } finally {
    await connection.close();
  }
}

async function grantOperatorMembership(databaseUrl: string, userId: string, workspaceId: string, role: string): Promise<void> {
  const connection = connectDatabase(databaseUrl);
  try {
    await connection.db.insert(identityMemberships).values({
      id: randomUUID(), userId, workspaceId, role, status: 'ACTIVE', joinedAt: new Date(),
    });
  } finally {
    await connection.close();
  }
}

async function platformLogin(base: string, email: string): Promise<string> {
  const result = await call(base, '/v1/platform/auth/login', postJson({ email, password }));
  assert(result.status === 201, 'platform login succeeds for ' + email);
  const token = (result.body as { token?: string }).token;
  assert(typeof token === 'string' && token.length >= 32, 'platform login returns an opaque session token');
  return token;
}

async function countConfigurationRecords(databaseUrl: string): Promise<number> {
  const connection = connectDatabase(databaseUrl);
  try {
    const [row] = await connection.db.select({ value: count() }).from(configurationRecords);
    return Number(row?.value ?? 0);
  } finally {
    await connection.close();
  }
}

async function configurationAuditRows(databaseUrl: string): Promise<Array<Record<string, unknown>>> {
  const connection = connectDatabase(databaseUrl);
  try {
    const rows = await connection.db.select().from(platformAdminAudit);
    return rows.filter(row => typeof row.action === 'string' && row.action.endsWith('_PLATFORM_CONFIGURATION')) as unknown as Array<Record<string, unknown>>;
  } finally {
    await connection.close();
  }
}

async function main(): Promise<void> {
  if (!process.env.QEYNOX_QA_DATABASE_URL) {
    console.log('BLOCKED: QEYNOX_QA_DATABASE_URL is not set. The platform configuration HTTP e2e suite needs an isolated PostgreSQL database; no result is claimed.');
    return;
  }
  const qa = await createIsolatedQaDatabase();
  process.env.DATABASE_URL = qa.url;
  process.env.QEYNOX_ALLOW_REGISTRATION = 'true';
  process.env.QEYNOX_OPERATOR_USER_IDS = cfgAdmin.userId;
  let app: INestApplication | undefined;
  try {
    const report = await runMigrations(qa.url);
    assert(report.total >= 12 && report.applied.length === report.total, 'every migration (including 0019 payments) applied to the disposable database');
    await seedPlatformAccounts(qa.url);

    app = await NestFactory.create(AppModule, { logger: false });
    app.useGlobalFilters(new DomainExceptionFilter());
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address() as { port: number };
    assert(Number.isInteger(address.port) && address.port > 0, 'NestJS application started with the platform configuration module');
    const base = 'http://127.0.0.1:' + address.port;

    // ---- two real workspaces; the platform admin only operators the first ------------------
    const ownerOne = await call(base, '/v1/auth/register', postJson({ email: 'qa-config-owner-one@example.invalid', password, workspaceName: 'QA Config One' }));
    assert(ownerOne.status === 201, 'workspace one registration succeeds');
    const ownerOneSession = ownerOne.body as { userId: string; workspaceId: string };
    const ownerOneToken = (ownerOne.body as { token: string }).token;
    const ownerTwo = await call(base, '/v1/auth/register', postJson({ email: 'qa-config-owner-two@example.invalid', password, workspaceName: 'QA Config Two' }));
    assert(ownerTwo.status === 201, 'workspace two registration succeeds');
    const ownerTwoSession = ownerTwo.body as { workspaceId: string };

    await grantOperatorMembership(qa.url, cfgAdmin.userId, ownerOneSession.workspaceId, 'OWNER');
    const ws1 = ownerOneSession.workspaceId;
    const ws2 = ownerTwoSession.workspaceId;

    const adminToken = await platformLogin(base, cfgAdmin.email);
    const auditorToken = await platformLogin(base, auditor.email);
    const supportToken = await platformLogin(base, support.email);
    const operationsToken = await platformLogin(base, operations.email);

    // ---- session namespace separation --------------------------------------------------------
    const ownerBearerOnPlatform = await call(base, '/v1/platform/configuration?workspaceId=' + ws1, { headers: bearer(ownerOneToken) });
    assert(ownerBearerOnPlatform.status === 403 && errorCode(ownerBearerOnPlatform) === 'DENIED', 'a workspace bearer can never reach the platform configuration route');
    const platformBearerOnWorkspace = await call(base, '/v1/operator/configuration', { headers: bearer(adminToken) });
    assert(platformBearerOnWorkspace.status === 403 && errorCode(platformBearerOnWorkspace) === 'DENIED', 'a platform bearer can never reach the workspace operator route');

    // ---- read authorization ------------------------------------------------------------------
    const noWorkspace = await call(base, '/v1/platform/configuration', { headers: bearer(adminToken) });
    assert(noWorkspace.status === 400 && errorCode(noWorkspace) === 'INVALID_INPUT', 'missing workspaceId is rejected with INVALID_INPUT');
    const badWorkspace = await call(base, '/v1/platform/configuration?workspaceId=!!', { headers: bearer(adminToken) });
    assert(badWorkspace.status === 400 && errorCode(badWorkspace) === 'INVALID_INPUT', 'malformed workspaceId is rejected with INVALID_INPUT');
    const supportRead = await call(base, '/v1/platform/configuration?workspaceId=' + ws1, { headers: bearer(supportToken) });
    assert(supportRead.status === 403 && errorCode(supportRead) === 'DENIED', 'SUPPORT cannot read configuration');
    const operationsRead = await call(base, '/v1/platform/configuration?workspaceId=' + ws1, { headers: bearer(operationsToken) });
    assert(operationsRead.status === 403 && errorCode(operationsRead) === 'DENIED', 'OPERATIONS cannot read configuration');
    const auditorRead = await call(base, '/v1/platform/configuration?workspaceId=' + ws1, { headers: bearer(auditorToken) });
    assert(auditorRead.status === 200, 'AUDITOR can read configuration state');
    const auditorState = auditorRead.body as { capabilities?: unknown[]; profiles?: unknown[]; offers?: unknown[] };
    assert(Array.isArray(auditorState.capabilities) && auditorState.capabilities.length === 8, 'state reports the eight capability slots');
    assert(Array.isArray(auditorState.profiles) && auditorState.profiles.length === 10, 'state reports soul, pilot and the eight business profiles');
    const unknownWorkspace = await call(base, '/v1/platform/configuration?workspaceId=ws_does_not_exist', { headers: bearer(auditorToken) });
    assert(unknownWorkspace.status === 404 && errorCode(unknownWorkspace) === 'NOT_FOUND', 'reading an unknown workspace is refused with NOT_FOUND');
    const adminRead = await call(base, '/v1/platform/configuration?workspaceId=' + ws1, { headers: bearer(adminToken) });
    assert(adminRead.status === 200, 'PLATFORM_ADMIN can read configuration state');

    // ---- mutation authorization --------------------------------------------------------------
    const auditorApply = await call(base, '/v1/platform/configuration/apply', { ...postJson({ workspaceId: ws1, reason: 'auditor attempt at configuration', idempotencyKey: 'qa-cfg-auditor-1', entries: [toolEntry] }), headers: bearer(auditorToken) });
    assert(auditorApply.status === 403 && errorCode(auditorApply) === 'DENIED', 'AUDITOR cannot apply configuration');
    const supportApply = await call(base, '/v1/platform/configuration/apply', { ...postJson({ workspaceId: ws1, reason: 'support attempt at configuration', idempotencyKey: 'qa-cfg-support-1', entries: [toolEntry] }), headers: bearer(supportToken) });
    assert(supportApply.status === 403 && errorCode(supportApply) === 'DENIED', 'SUPPORT cannot apply configuration');
    const operationsPreview = await call(base, '/v1/platform/configuration/preview', { ...postJson({ workspaceId: ws1, reason: 'operations attempt at preview', idempotencyKey: 'qa-cfg-operations-1', entries: [toolEntry] }), headers: bearer(operationsToken) });
    assert(operationsPreview.status === 403 && errorCode(operationsPreview) === 'DENIED', 'OPERATIONS cannot preview configuration');
    const noMembershipApply = await call(base, '/v1/platform/configuration/apply', { ...postJson({ workspaceId: ws2, reason: 'apply in a workspace without membership', idempotencyKey: 'qa-cfg-ws2-1', entries: [toolEntry] }), headers: bearer(adminToken) });
    assert(noMembershipApply.status === 403 && errorCode(noMembershipApply) === 'DENIED', 'a platform admin without an ACTIVE membership in the target workspace is refused by the operator gate');

    const allowlist = process.env.QEYNOX_OPERATOR_USER_IDS;
    delete process.env.QEYNOX_OPERATOR_USER_IDS;
    const failClosed = await call(base, '/v1/platform/configuration/apply', { ...postJson({ workspaceId: ws1, reason: 'attempt while allowlist is unset', idempotencyKey: 'qa-cfg-closed-1', entries: [toolEntry] }), headers: bearer(adminToken) });
    assert(failClosed.status === 503 && errorCode(failClosed) === 'NOT_CONFIGURED', 'the engine fails closed with NOT_CONFIGURED when QEYNOX_OPERATOR_USER_IDS is unset');
    process.env.QEYNOX_OPERATOR_USER_IDS = 'someone-else-entirely';
    const notAllowlisted = await call(base, '/v1/platform/configuration/apply', { ...postJson({ workspaceId: ws1, reason: 'attempt as a non-allowlisted operator', idempotencyKey: 'qa-cfg-denied-1', entries: [toolEntry] }), headers: bearer(adminToken) });
    assert(notAllowlisted.status === 403 && errorCode(notAllowlisted) === 'DENIED', 'a platform admin outside the operator allowlist is refused');
    process.env.QEYNOX_OPERATOR_USER_IDS = allowlist;

    // ---- preview: computes outcomes, persists nothing ---------------------------------------
    const previewKey = 'qa-cfg-preview-1';
    const preview = await call(base, '/v1/platform/configuration/preview', { ...postJson({ workspaceId: ws1, reason: 'preview the tool bundle before applying', idempotencyKey: previewKey, entries: [toolEntry] }), headers: bearer(adminToken) });
    assert(preview.status === 201, 'preview succeeds for an allowlisted operator');
    const previewBody = preview.body as ApplyResult;
    assert(previewBody.dryRun === true, 'preview is marked as a dry run');
    assert(previewBody.alreadyApplied === false, 'preview is never reported as already applied');
    assert(typeof previewBody.digest === 'string' && /^[0-9a-f]{64}$/.test(previewBody.digest), 'preview returns a sha256 digest of the bundle');
    assert(previewBody.changes?.length === 1 && previewBody.changes[0]?.outcome === 'CREATE', 'preview computes the CREATE outcome without persisting');
    assert(await countConfigurationRecords(qa.url) === 0, 'a dry run writes no configuration_records row');

    // ---- apply: immutable, idempotency-key guarded, audited in the same transaction ----------
    const apply = await call(base, '/v1/platform/configuration/apply', { ...postJson({ workspaceId: ws1, reason: 'apply the tool bundle for the QA workspace', idempotencyKey: previewKey, entries: [toolEntry] }), headers: bearer(adminToken) });
    assert(apply.status === 201, 'applying the previewed bundle succeeds');
    const applyBody = apply.body as ApplyResult;
    assert(applyBody.dryRun === false && applyBody.alreadyApplied === false, 'the real apply executes and is not a replay');
    assert(applyBody.digest === previewBody.digest, 'the apply produces the same digest as the preview');
    assert(await countConfigurationRecords(qa.url) === 1, 'the apply persists exactly one configuration_records row');

    const replay = await call(base, '/v1/platform/configuration/apply', { ...postJson({ workspaceId: ws1, reason: 'replay the same idempotent apply', idempotencyKey: previewKey, entries: [toolEntry] }), headers: bearer(adminToken) });
    assert(replay.status === 201 && (replay.body as ApplyResult).alreadyApplied === true, 'replaying the idempotency key returns the stored outcome');
    assert(await countConfigurationRecords(qa.url) === 1, 'the replay persists nothing new');

    const conflictingReplay = await call(base, '/v1/platform/configuration/apply', { ...postJson({ workspaceId: ws1, reason: 'reuse the key for a different bundle', idempotencyKey: previewKey, entries: [toolEntry, capabilityEntry] }), headers: bearer(adminToken) });
    assert(conflictingReplay.status === 409 && errorCode(conflictingReplay) === 'CONFLICT', 'the same idempotency key cannot smuggle a different bundle');

    // ---- capability + offer tax gate ----------------------------------------------------------
    const capabilityApply = await call(base, '/v1/platform/configuration/apply', { ...postJson({ workspaceId: ws1, reason: 'activate the QA capability slot three', idempotencyKey: 'qa-cfg-capability-1', entries: [capabilityEntry] }), headers: bearer(adminToken) });
    assert(capabilityApply.status === 201, 'applying the ACTIVE capability succeeds');
    const taxedOffer = await call(base, '/v1/platform/configuration/apply', { ...postJson({ workspaceId: ws1, reason: 'offer without tax treatment must be refused', idempotencyKey: 'qa-cfg-offer-tax-1', entries: [offerEntry()] }), headers: bearer(adminToken) });
    assert(taxedOffer.status === 503 && errorCode(taxedOffer) === 'NOT_CONFIGURED', 'an ACTIVE offer with taxPolicy=CONFIG_REQUIRED is refused');
    const configuredOffer = await call(base, '/v1/platform/configuration/apply', { ...postJson({ workspaceId: ws1, reason: 'offer with explicitly configured tax treatment', idempotencyKey: 'qa-cfg-offer-ok-1', entries: [offerEntry({ taxPolicy: 'CONFIGURED' })] }), headers: bearer(adminToken) });
    assert(configuredOffer.status === 201, 'an ACTIVE offer with taxPolicy=CONFIGURED is accepted');
    const immutableOffer = await call(base, '/v1/platform/configuration/apply', { ...postJson({ workspaceId: ws1, reason: 'change amount of an existing offer version', idempotencyKey: 'qa-cfg-offer-immutable-1', entries: [offerEntry({ taxPolicy: 'CONFIGURED', amountMinor: 20000 })] }), headers: bearer(adminToken) });
    assert(immutableOffer.status === 409 && errorCode(immutableOffer) === 'CONFLICT', 'offer version content is immutable once written');

    // ---- verification policy + budgets ---------------------------------------------------------
    const verification = await call(base, '/v1/platform/configuration/apply', { ...postJson({ workspaceId: ws1, reason: 'activate verification policy for the QA capability', idempotencyKey: 'qa-cfg-verify-1', entries: [verificationEntry] }), headers: bearer(adminToken) });
    assert(verification.status === 201, 'applying the verification policy succeeds');
    const budgetOne = await call(base, '/v1/platform/configuration/apply', { ...postJson({ workspaceId: ws1, reason: 'activate the first QA budget policy', idempotencyKey: 'qa-cfg-budget-1', entries: [budgetEntry(1)] }), headers: bearer(adminToken) });
    assert(budgetOne.status === 201, 'applying the first ACTIVE budget policy succeeds');
    const budgetTwo = await call(base, '/v1/platform/configuration/apply', { ...postJson({ workspaceId: ws1, reason: 'supersede with a second ACTIVE budget policy', idempotencyKey: 'qa-cfg-budget-2', entries: [budgetEntry(2)] }), headers: bearer(adminToken) });
    assert(budgetTwo.status === 201, 'a newer ACTIVE budget policy supersedes the older one');

    // ---- validation + input hygiene ------------------------------------------------------------
    const missingReason = await call(base, '/v1/platform/configuration/apply', { ...postJson({ workspaceId: ws1, idempotencyKey: 'qa-cfg-no-reason', entries: [toolEntry] }), headers: bearer(adminToken) });
    assert(missingReason.status === 400 && errorCode(missingReason) === 'INVALID_INPUT', 'a missing justification is rejected');
    const badProvider = await call(base, '/v1/platform/configuration/apply', { ...postJson({ workspaceId: ws1, reason: 'budget references an unknown tool provider', idempotencyKey: 'qa-cfg-bad-provider-1', entries: [{ ...budgetEntry(3), version: 3, unitMaxMinor: { 'nope:unknown@1.0.0': 10 } }] }), headers: bearer(adminToken) });
    assert(badProvider.status === 400 && errorCode(badProvider) === 'INVALID_INPUT', 'a budget ceiling for an unknown tool provider is rejected');

    // ---- read-back: the state surfaced to the Control console ---------------------------------
    const readBack = await call(base, '/v1/platform/configuration?workspaceId=' + ws1, { headers: bearer(adminToken) });
    assert(readBack.status === 200, 'state reads back after the applies');
    const readState = readBack.body as {
      capabilities: Array<{ slot: number; status: string }>;
      tools: Array<{ connectorId: string; status: string }>;
      verificationPolicies: Array<{ capabilityId: string; minimumSources: number }>;
      offers: Array<{ offerId: string; taxPolicy: string; label: string; status: string }>;
      budgetPolicies: Array<{ policyId: string; status: string; version: number }>;
    };
    assert(readState.capabilities.find(row => row.slot === 3)?.status === 'ACTIVE', 'capability slot three reads back ACTIVE');
    assert(readState.tools.some(row => row.connectorId === 'qa-invoice' && row.status === 'ACTIVE'), 'the applied tool reads back ACTIVE');
    assert(readState.verificationPolicies.some(row => row.capabilityId === 'capability-slot-3-v1' && row.minimumSources === 2), 'the verification policy reads back with its minimum sources');
    const offerView = readState.offers.find(row => row.offerId === 'qa-offer-standard');
    assert(offerView?.taxPolicy === 'CONFIGURED' && typeof offerView.label === 'string' && offerView.label.length > 0, 'offers expose their tax treatment and label to the console');
    const activeBudgets = readState.budgetPolicies.filter(row => row.policyId === 'qa-budget' && row.status === 'ACTIVE');
    assert(activeBudgets.length === 1 && activeBudgets[0]?.version === 2, 'exactly one ACTIVE budget policy survives the supersession');

    // ---- audit trail: append-only, same-transaction commits ------------------------------------
    const auditRows = await configurationAuditRows(qa.url);
    const actions = auditRows.map(row => String(row.action));
    assert(actions.includes('READ_PLATFORM_CONFIGURATION'), 'configuration reads are audited');
    assert(actions.includes('PREVIEW_PLATFORM_CONFIGURATION'), 'configuration previews are audited');
    assert(actions.includes('APPLY_PLATFORM_CONFIGURATION'), 'configuration applications are audited');
    const applySuccesses = auditRows.filter(row => row.action === 'APPLY_PLATFORM_CONFIGURATION' && row.outcome === 'SUCCESS' && row.targetId === ws1);
    assert(applySuccesses.length >= 5, 'every successful apply commits an audit row');
    assert(applySuccesses.every(row => row.actorUserId === cfgAdmin.userId && row.permission === 'ADMINISTRATION'), 'apply audit rows identify actor and permission');
    assert(applySuccesses.every(row => typeof row.reason === 'string' && row.reason.length >= 10), 'apply audit rows carry the written justification');
    const applyDetails = applySuccesses.map(row => row.detail as { dryRun?: boolean; idempotencyKey?: string; digest?: string; alreadyApplied?: boolean; changes?: unknown[] });
    assert(applyDetails.some(detail => detail?.dryRun === false && Array.isArray(detail.changes) && typeof detail.digest === 'string'), 'apply audit details carry dryRun, changes and digest');
    assert(applyDetails.some(detail => detail?.alreadyApplied === true), 'the idempotent replay is audited as alreadyApplied');
    const previewAudit = auditRows.find(row => row.action === 'PREVIEW_PLATFORM_CONFIGURATION' && row.outcome === 'SUCCESS');
    assert((previewAudit?.detail as { dryRun?: boolean } | null)?.dryRun === true, 'the preview audit records the dry-run flag');
    const deniedApplies = auditRows.filter(row => row.action === 'APPLY_PLATFORM_CONFIGURATION' && row.outcome === 'DENIED');
    assert(deniedApplies.length >= 4, 'permission, gate and engine denials are audited');
    const deniedReads = auditRows.filter(row => row.action === 'READ_PLATFORM_CONFIGURATION' && row.outcome === 'DENIED');
    assert(deniedReads.length >= 2, 'SUPPORT and OPERATIONS read attempts are audited as denied');
    const taxDenial = deniedApplies.find(row => row.reason === 'NOT_CONFIGURED');
    assert(Boolean(taxDenial), 'the refused ACTIVE offer is audited with the engine reason');
    // The refused ACTIVE offer committed no configuration mutation: its audit row exists, but only the successful applies persisted rows.
    assert(await countConfigurationRecords(qa.url) === 6, 'denied applications persist no configuration records');

    await app.close();
    app = undefined;
    console.log('Platform configuration e2e PASSED:', assertions, 'assertions against an isolated PostgreSQL database');
  } finally {
    if (app) await app.close().catch(() => undefined);
    await qa.drop();
    console.log('QA database dropped:', qa.name);
  }
}

main().catch((error: unknown) => {
  console.error('Platform configuration e2e FAILED:', error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});

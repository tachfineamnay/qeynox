/**
 * Platform administration end-to-end QA (isolated PostgreSQL only).
 *
 * Requires QEYNOX_QA_DATABASE_URL pointing at a disposable local PostgreSQL role. It creates a
 * brand-new database, applies all 12 migrations, seeds platform administrators directly (there is
 * no web self-service assignment) and boots the real NestJS API to exercise HTTP authorization.
 *
 * Core guarantee tested here: a workspace OWNER signed in with a workspace bearer token can never
 * reach /v1/platform/*, while a platform session never reaches tenant routes. It also covers the
 * explicit assignment/revocation mechanism, the audit trail, the last-administrator rule and the
 * absence of workspace memberships for platform accounts.
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
  platformAdminSessions,
  runMigrations,
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

const password = 'platform-qa-passphrase';
const admin = { userId: 'qa-platform-admin', email: 'qa-admin@example.invalid' };
const adminTwo = { userId: 'qa-platform-admin-two', email: 'qa-admin-two@example.invalid' };
const support = { userId: 'qa-platform-support', email: 'qa-support@example.invalid' };
const operations = { userId: 'qa-platform-operations', email: 'qa-operations@example.invalid' };
const auditor = { userId: 'qa-platform-auditor', email: 'qa-auditor@example.invalid' };
const workspaceOwnerEmail = 'qa-workspace-owner@example.invalid';

const seedAssignments: ReadonlyArray<readonly [string, string]> = [
  [admin.userId, 'PLATFORM_ADMIN'],
  [support.userId, 'SUPPORT'],
  [operations.userId, 'OPERATIONS'],
  [auditor.userId, 'AUDITOR'],
];

async function seedPlatformAccounts(databaseUrl: string): Promise<void> {
  const connection = connectDatabase(databaseUrl);
  try {
    const db = connection.db;
    const credential = await hashPassword(password);
    for (const account of [admin, adminTwo, support, operations, auditor]) {
      await db.insert(identityUsers).values({ id: account.userId, email: account.email, locale: 'en' });
      await db.insert(identityCredentials).values({ userId: account.userId, salt: credential.salt, passwordHash: credential.hash });
    }
    for (const [userId, role] of seedAssignments) {
      await db.insert(platformAdminAssignments).values({
        id: randomUUID(), userId, role, status: 'ACTIVE', grantedBy: 'QA_FIXTURE',
        grantReason: 'deterministic platform administration seed',
      });
    }
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

async function main(): Promise<void> {
  if (!process.env.QEYNOX_QA_DATABASE_URL) {
    console.log('BLOCKED: QEYNOX_QA_DATABASE_URL is not set. The platform administration HTTP e2e suite needs an isolated PostgreSQL database; no result is claimed.');
    return;
  }
  const qa = await createIsolatedQaDatabase();
  process.env.DATABASE_URL = qa.url;
  process.env.QEYNOX_ALLOW_REGISTRATION = 'true';
  delete process.env.QEYNOX_OPERATOR_USER_IDS;
  let app: INestApplication | undefined;
  try {
    const report = await runMigrations(qa.url);
    assert(report.total === 12 && report.applied.length === 12, 'all 12 migrations (including 0012 platform administration) applied to the disposable database');
    const rerun = await runMigrations(qa.url);
    assert(rerun.applied.length === 0 && rerun.skipped.length === 12, 're-running migrations changes nothing: applied migration content stays immutable');
    await seedPlatformAccounts(qa.url);

    app = await NestFactory.create(AppModule, { logger: false });
    app.useGlobalFilters(new DomainExceptionFilter());
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address() as { port: number };
    assert(Number.isInteger(address.port) && address.port > 0, 'NestJS application started with the platform module');
    const base = 'http://127.0.0.1:' + address.port;

    // ---- a workspace OWNER must never reach global administration ---------------------------
    const registered = await call(base, '/v1/auth/register', postJson({ email: workspaceOwnerEmail, password, workspaceName: 'QA Platform Copy' }));
    assert(registered.status === 201, 'workspace owner registration succeeds');
    const ownerSession = registered.body as { token: string; userId: string; workspaceId: string };
    const ownerHeaders = bearer(ownerSession.token);
    const created = await call(base, '/v1/operations', { ...postJson({ title: 'QA platform operation', goal: 'Verify platform administration isolation', constraints: [] }), headers: ownerHeaders });
    assert(created.status === 201 && (created.body as { status?: string }).status === 'DRAFT', 'workspace owner owns a real operation');
    const operationId = (created.body as { id: string }).id;

    const platformRoutes: ReadonlyArray<readonly [string, 'GET' | 'POST']> = [
      ['/v1/platform/admins', 'GET'],
      ['/v1/platform/audit', 'GET'],
      ['/v1/platform/admins/' + ownerSession.userId + '/assign', 'POST'],
      ['/v1/platform/admins/' + ownerSession.userId + '/revoke', 'POST'],
      ['/v1/platform/support/operations/' + operationId, 'GET'],
      ['/v1/platform/operations/' + operationId + '/runtime', 'GET'],
      ['/v1/platform/auth/me', 'GET'],
      ['/v1/platform/auth/logout', 'POST'],
    ];
    for (const [path, method] of platformRoutes) {
      const result = await call(base, path, method === 'GET' ? { headers: ownerHeaders } : { ...postJson({ role: 'AUDITOR', reason: 'workspace owner attempt' }), headers: ownerHeaders });
      assert(result.status === 403 && errorCode(result) === 'DENIED', 'workspace OWNER is denied ' + method + ' ' + path);
    }
    const ownerPlatformLoginDenied = await call(base, '/v1/platform/auth/login', postJson({ email: workspaceOwnerEmail, password }));
    assert(ownerPlatformLoginDenied.status === 403 && errorCode(ownerPlatformLoginDenied) === 'DENIED', 'workspace ownership alone cannot open a platform session');

    // ---- explicit assignment mechanism ------------------------------------------------------
    const adminToken = await platformLogin(base, admin.email);
    const adminMe = await call(base, '/v1/platform/auth/me', { headers: bearer(adminToken) });
    assert(adminMe.status === 200, 'platform session resolves its own identity');
    const adminInfo = adminMe.body as { roles: string[]; permissions: string[] };
    assert(adminInfo.roles.join(',') === 'PLATFORM_ADMIN', 'platform administrator role is returned');
    assert(adminInfo.permissions.join(',') === 'ADMINISTRATION,CONSULTATION', 'general administration holds minimum permissions');

    const assigned = await call(base, '/v1/platform/admins/' + ownerSession.userId + '/assign', { ...postJson({ role: 'AUDITOR', reason: 'explicit consultation assignment for QA' }), headers: bearer(adminToken) });
    assert(assigned.status === 201 && (assigned.body as { status?: string }).status === 'ACTIVE', 'platform administrator can explicitly assign a platform role');
    const ownerPlatformToken = await platformLogin(base, workspaceOwnerEmail);
    const ownerPlatformMe = await call(base, '/v1/platform/auth/me', { headers: bearer(ownerPlatformToken) });
    const ownerPlatformInfo = ownerPlatformMe.body as { roles: string[]; permissions: string[] };
    assert(ownerPlatformInfo.roles.join(',') === 'AUDITOR', 'the workspace owner gains only the explicitly assigned platform role');
    assert(ownerPlatformInfo.permissions.join(',') === 'CONSULTATION', 'the explicitly assigned permission set is minimal');
    const ownerCannotAdminister = await call(base, '/v1/platform/admins/' + support.userId + '/assign', { ...postJson({ role: 'SUPPORT', reason: 'elevation attempt' }), headers: bearer(ownerPlatformToken) });
    assert(ownerCannotAdminister.status === 403 && errorCode(ownerCannotAdminister) === 'DENIED', 'an assigned workspace owner still cannot administer platforms');
    const ownerWorkspaceBearerStillDenied = await call(base, '/v1/platform/admins', { headers: ownerHeaders });
    assert(ownerWorkspaceBearerStillDenied.status === 403 && errorCode(ownerWorkspaceBearerStillDenied) === 'DENIED', 'the workspace bearer token remains unable to reach administration');

    const duplicate = await call(base, '/v1/platform/admins/' + ownerSession.userId + '/assign', { ...postJson({ role: 'AUDITOR', reason: 'duplicate assignment attempt' }), headers: bearer(adminToken) });
    assert(duplicate.status === 409 && errorCode(duplicate) === 'CONFLICT', 'duplicate assignment is refused');
    const invalidRole = await call(base, '/v1/platform/admins/' + ownerSession.userId + '/assign', { ...postJson({ role: 'OWNER', reason: 'workspace role must not become a platform role' }), headers: bearer(adminToken) });
    assert(invalidRole.status === 400 && errorCode(invalidRole) === 'INVALID_INPUT', 'workspace roles cannot be assigned as platform roles');
    const unknownUser = await call(base, '/v1/platform/admins/user-unknown-0001/assign', { ...postJson({ role: 'SUPPORT', reason: 'unknown identity target' }), headers: bearer(adminToken) });
    assert(unknownUser.status === 404 && errorCode(unknownUser) === 'NOT_FOUND', 'assignment to an unknown identity is refused');

    const revoked = await call(base, '/v1/platform/admins/' + ownerSession.userId + '/revoke', { ...postJson({ role: 'AUDITOR', reason: 'QA revocation' }), headers: bearer(adminToken) });
    assert(revoked.status === 201 && (revoked.body as { status?: string }).status === 'REVOKED', 'platform administrator can revoke an assignment');
    const ownerTokenAfterRevoke = await call(base, '/v1/platform/auth/me', { headers: bearer(ownerPlatformToken) });
    assert(ownerTokenAfterRevoke.status === 403 && errorCode(ownerTokenAfterRevoke) === 'DENIED', 'revocation invalidates the previously issued platform session');
    const ownerLoginAfterRevoke = await call(base, '/v1/platform/auth/login', postJson({ email: workspaceOwnerEmail, password }));
    assert(ownerLoginAfterRevoke.status === 403 && errorCode(ownerLoginAfterRevoke) === 'DENIED', 'revoked assignment blocks future platform login');

    // ---- last administrator protection ------------------------------------------------------
    const lastAdmin = await call(base, '/v1/platform/admins/' + admin.userId + '/revoke', { ...postJson({ role: 'PLATFORM_ADMIN', reason: 'last administrator attempt' }), headers: bearer(adminToken) });
    assert(lastAdmin.status === 403 && errorCode(lastAdmin) === 'DENIED', 'the last platform administrator cannot be revoked');

    // ---- permission separation across support / operations / consultation -------------------
    const supportToken = await platformLogin(base, support.email);
    const operationsToken = await platformLogin(base, operations.email);
    const auditorToken = await platformLogin(base, auditor.email);

    const supportSummary = await call(base, '/v1/platform/support/operations/' + operationId, { headers: bearer(supportToken) });
    assert(supportSummary.status === 200, 'support reads cross-workspace operation diagnostics');
    const summaryBody = supportSummary.body as { workspaceId?: string; title?: string };
    assert(summaryBody.workspaceId === ownerSession.workspaceId && summaryBody.title === 'QA platform operation', 'support diagnostics expose the real operation');
    const supportRuntime = await call(base, '/v1/platform/operations/' + operationId + '/runtime', { headers: bearer(supportToken) });
    assert(supportRuntime.status === 403 && errorCode(supportRuntime) === 'DENIED', 'support cannot read technical runtime state');
    const supportAssign = await call(base, '/v1/platform/admins/' + admin.userId + '/assign', { ...postJson({ role: 'SUPPORT', reason: 'support escalation attempt' }), headers: bearer(supportToken) });
    assert(supportAssign.status === 403 && errorCode(supportAssign) === 'DENIED', 'support cannot assign platform roles');

    const operationsRuntime = await call(base, '/v1/platform/operations/' + operationId + '/runtime', { headers: bearer(operationsToken) });
    assert(operationsRuntime.status === 200, 'operations reads technical runtime state');
    const operationsSupport = await call(base, '/v1/platform/support/operations/' + operationId, { headers: bearer(operationsToken) });
    assert(operationsSupport.status === 403 && errorCode(operationsSupport) === 'DENIED', 'operations cannot use customer-support diagnostics');

    const auditorAssignments = await call(base, '/v1/platform/admins', { headers: bearer(auditorToken) });
    assert(auditorAssignments.status === 200 && Array.isArray(auditorAssignments.body), 'auditor can consult platform assignments');
    const auditorAssign = await call(base, '/v1/platform/admins/' + admin.userId + '/assign', { ...postJson({ role: 'SUPPORT', reason: 'auditor escalation attempt' }), headers: bearer(auditorToken) });
    assert(auditorAssign.status === 403 && errorCode(auditorAssign) === 'DENIED', 'auditor cannot mutate assignments');

    // ---- audit trail: actor, target, action, date, result -----------------------------------
    const audit = await call(base, '/v1/platform/audit?limit=200', { headers: bearer(adminToken) });
    assert(audit.status === 200 && Array.isArray(audit.body), 'platform administrator can read the audit trail');
    const auditRows = audit.body as Array<Record<string, unknown>>;
    assert(auditRows.length > 10, 'audit trail records the exercised platform operations');
    assert(auditRows.every(row => typeof row.id === 'string' && typeof row.targetType === 'string' && typeof row.action === 'string' && typeof row.outcome === 'string' && typeof row.happenedAt === 'string'), 'every audit row carries target, action, date and result');
    const actions = new Set(auditRows.map(row => row.action));
    assert(actions.has('LOGIN') && actions.has('ASSIGN_PLATFORM_ROLE') && actions.has('REVOKE_PLATFORM_ROLE') && actions.has('LIST_PLATFORM_AUDIT'), 'audit trail covers login, assignment, revocation and consultation');
    assert(auditRows.some(row => row.outcome === 'DENIED'), 'denied platform attempts are audited');
    assert(auditRows.some(row => typeof row.actorUserId === 'string' && row.actorUserId === admin.userId), 'audit rows identify the acting administrator');

    // ---- strict session namespace separation ------------------------------------------------
    const platformToTenant = await call(base, '/v1/operations', { headers: bearer(adminToken) });
    assert(platformToTenant.status === 403 && errorCode(platformToTenant) === 'DENIED', 'a platform bearer cannot call tenant routes');
    const loggedOut = await call(base, '/v1/platform/auth/logout', { method: 'POST', headers: bearer(adminToken) });
    assert(loggedOut.status === 201, 'platform logout succeeds');
    const adminAfterLogout = await call(base, '/v1/platform/auth/me', { headers: bearer(adminToken) });
    assert(adminAfterLogout.status === 403 && errorCode(adminAfterLogout) === 'DENIED', 'logged-out platform session is rejected');

    // ---- concurrent last-administrator revocation ------------------------------------------
    // The last-admin rule must hold even when two administrators revoke each other concurrently:
    // the revocation transaction locks the active administrator rows and re-counts inside it.
    const adminTokenFresh = await platformLogin(base, admin.email);
    const secondAdminGranted = await call(base, '/v1/platform/admins/' + adminTwo.userId + '/assign', {
      ...postJson({ role: 'PLATFORM_ADMIN', reason: 'second administrator for concurrency QA' }), headers: bearer(adminTokenFresh),
    });
    assert(secondAdminGranted.status === 201, 'a second platform administrator can be assigned');
    const adminTwoToken = await platformLogin(base, adminTwo.email);
    const revokeCall = (token: string, userId: string): Promise<HttpResult> => call(base, '/v1/platform/admins/' + userId + '/revoke', {
      ...postJson({ role: 'PLATFORM_ADMIN', reason: 'concurrent last-administrator check' }), headers: bearer(token),
    });
    const concurrent = await Promise.all([revokeCall(adminTokenFresh, admin.userId), revokeCall(adminTwoToken, adminTwo.userId)]);
    const concurrentSuccesses = concurrent.filter(result => result.status === 201).length;
    assert(concurrentSuccesses === 1, 'exactly one of two concurrent self-revocations succeeds');
    assert(concurrent.some(result => result.status === 403 && errorCode(result) === 'DENIED'), 'the losing concurrent revocation is denied');
    const adminLoginAfter = await call(base, '/v1/platform/auth/login', postJson({ email: admin.email, password }));
    const adminTwoLoginAfter = await call(base, '/v1/platform/auth/login', postJson({ email: adminTwo.email, password }));
    assert((adminLoginAfter.status === 201) !== (adminTwoLoginAfter.status === 201), 'exactly one platform administrator survives the concurrent revocation');

    // ---- persistence invariants -------------------------------------------------------------
    const inspection = connectDatabase(qa.url);
    try {
      const db = inspection.db;
      const [assignmentCount] = await db.select({ value: count() }).from(platformAdminAssignments);
      const [sessionCount] = await db.select({ value: count() }).from(platformAdminSessions);
      const [auditCount] = await db.select({ value: count() }).from(platformAdminAudit);
      const [platformMemberships] = await db.select({ value: count() }).from(identityMemberships).where(eq(identityMemberships.userId, admin.userId));
      const [activeAdmins] = await db.select({ value: count() }).from(platformAdminAssignments)
        .where(and(eq(platformAdminAssignments.role, 'PLATFORM_ADMIN'), eq(platformAdminAssignments.status, 'ACTIVE')));
      assert(Number(assignmentCount?.value ?? 0) >= 5, 'platform assignments are persisted');
      assert(Number(sessionCount?.value ?? 0) >= 4, 'platform sessions are persisted separately');
      assert(Number(auditCount?.value ?? 0) >= 20, 'the audit trail is durable');
      assert(Number(activeAdmins?.value ?? 0) >= 1, 'concurrent revocation leaves at least one platform administrator');
      assert(Number(platformMemberships?.value ?? 0) === 0, 'platform administrators hold no workspace membership');
    } finally {
      await inspection.close();
    }

    await app.close();
    app = undefined;
    console.log('Platform administration e2e PASSED:', assertions, 'assertions against an isolated PostgreSQL database');
  } finally {
    if (app) await app.close().catch(() => undefined);
    await qa.drop();
    console.log('QA database dropped:', qa.name);
  }
}

main().catch((error: unknown) => {
  console.error('Platform administration e2e FAILED:', error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});

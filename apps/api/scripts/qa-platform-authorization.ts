/**
 * Platform administration authorization QA (no database required).
 *
 * Part A exercises the real PlatformAdminService and PlatformAccessGuard against an in-memory
 * repository + credential port. Part B boots the real NestJS application with an unreachable
 * database URL and verifies HTTP wiring/protection paths that never reach PostgreSQL.
 *
 * The workspace-owner guarantee is asserted here: a workspace OWNER has no platform assignment, a
 * workspace bearer token is unknown to the platform session store, and both the service and the
 * guard deny access. The isolated-PostgreSQL HTTP flow lives in qa-platform-admin.ts.
 */
import 'reflect-metadata';
import { createHash } from 'node:crypto';
import type { ExecutionContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Reflector } from '@nestjs/core';
import {
  DomainError,
  isPlatformRole,
  platformPermissionsForRoles,
  type ID,
  type PlatformPrincipal,
  type PlatformRole,
} from '@qeynox/domain';
import {
  PlatformAdminService,
  type IdentityCredentialVerifier,
  type PlatformAdminRepository,
  type PlatformRevokeGuardInput,
} from '@qeynox/application';
import type {
  PlatformAssignmentRecord,
  PlatformAuditRecord,
  PlatformOperationRuntime,
  PlatformOperationSummary,
  PlatformRevokeOutcome,
  PlatformSessionRecord,
} from '@qeynox/persistence';
import { AppModule } from '../src/app.module';
import { DomainExceptionFilter } from '../src/transport/domain-exception.filter';
import { PlatformAccessGuard } from '../src/platform/platform-access.guard';
import { PlatformAccess, PlatformRoute } from '../src/auth/platform-route';

let assertions = 0;
function assert(condition: unknown, message: string): asserts condition {
  assertions++;
  if (!condition) throw new Error('ASSERTION FAILED: ' + message);
}

async function expectDomainError(code: string, run: () => Promise<unknown> | unknown, label: string): Promise<DomainError> {
  assertions++;
  try {
    await run();
  } catch (error: unknown) {
    if (error instanceof DomainError && error.code === code) return error;
    throw new Error('EXPECTED ' + code + ' for ' + label + ', got ' + (error instanceof DomainError ? error.code : String(error)));
  }
  throw new Error('EXPECTED ' + code + ' for ' + label + ', but no error was raised');
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

class FakeClock {
  value = new Date('2026-11-13T12:00:00.000Z');
  advance(milliseconds: number): void { this.value = new Date(this.value.getTime() + milliseconds); }
}

class FakeCredentials implements IdentityCredentialVerifier {
  private readonly accounts = new Map<string, { userId: ID; password: string }>();
  register(email: string, userId: string, password: string): void {
    this.accounts.set(email.toLowerCase(), { userId: userId as ID, password });
  }
  async verifyCredentials(email: string, password: string): Promise<{ userId: ID }> {
    const account = this.accounts.get(email.toLowerCase());
    if (!account || account.password !== password) throw new DomainError('DENIED', 'Invalid credentials');
    return { userId: account.userId };
  }
}

class FakePlatformRepository implements PlatformAdminRepository {
  readonly users = new Map<string, { id: string; email: string; disabledAt: Date | null }>();
  readonly assignments: PlatformAssignmentRecord[] = [];
  readonly sessions: PlatformSessionRecord[] = [];
  readonly audits: PlatformAuditRecord[] = [];
  readonly summaries = new Map<string, PlatformOperationSummary>();
  readonly runtimes = new Map<string, PlatformOperationRuntime>();
  readonly calls: string[] = [];

  private record(name: string): void { this.calls.push(name); }

  async findIdentityUser(userId: string): Promise<{ readonly id: string; readonly email: string; readonly disabledAt: Date | null } | undefined> {
    this.record('findIdentityUser'); return this.users.get(userId);
  }
  async listActiveAssignments(userId: string): Promise<readonly PlatformAssignmentRecord[]> {
    this.record('listActiveAssignments');
    return this.assignments.filter(a => a.userId === userId && a.status === 'ACTIVE')
      .sort((a, b) => a.grantedAt.getTime() - b.grantedAt.getTime());
  }
  async findActiveAssignment(userId: string, role: PlatformRole): Promise<PlatformAssignmentRecord | undefined> {
    this.record('findActiveAssignment');
    return this.assignments.find(a => a.userId === userId && a.role === role && a.status === 'ACTIVE');
  }
  async listAssignments(limit: number): Promise<readonly PlatformAssignmentRecord[]> {
    this.record('listAssignments');
    return [...this.assignments].sort((a, b) => b.grantedAt.getTime() - a.grantedAt.getTime()).slice(0, limit);
  }
  private revokeSessionsOf(userId: string, at: Date): number {
    let changed = 0;
    for (let index = 0; index < this.sessions.length; index++) {
      const session = this.sessions[index];
      if (session !== undefined && session.userId === userId && !session.revokedAt) {
        this.sessions[index] = { ...session, revokedAt: at };
        changed++;
      }
    }
    return changed;
  }
  async findSessionByTokenHash(tokenHash: string): Promise<PlatformSessionRecord | undefined> {
    this.record('findSessionByTokenHash'); return this.sessions.find(s => s.tokenHash === tokenHash);
  }
  async touchSession(id: string, at: Date): Promise<void> {
    this.record('touchSession');
    const index = this.sessions.findIndex(s => s.id === id);
    const current = this.sessions[index];
    if (index >= 0 && current !== undefined) this.sessions[index] = { ...current, lastUsedAt: at };
  }
  async insertSessionWithAudit(session: PlatformSessionRecord, audit: PlatformAuditRecord): Promise<void> {
    this.record('insertSessionWithAudit');
    this.sessions.push(session);
    this.audits.push(audit);
  }
  async revokeSessionWithAudit(sessionId: string, at: Date, audit: PlatformAuditRecord): Promise<void> {
    this.record('revokeSessionWithAudit');
    const index = this.sessions.findIndex(s => s.id === sessionId);
    const current = this.sessions[index];
    if (index >= 0 && current !== undefined && !current.revokedAt) this.sessions[index] = { ...current, revokedAt: at };
    this.audits.push(audit);
  }
  async assignWithAudit(assignment: PlatformAssignmentRecord, audit: PlatformAuditRecord, targetUserId: string, at: Date): Promise<'INSERTED' | 'CONFLICT'> {
    this.record('assignWithAudit');
    if (this.assignments.some(a => a.userId === assignment.userId && a.role === assignment.role && a.status === 'ACTIVE')) return 'CONFLICT';
    this.assignments.push(assignment);
    this.revokeSessionsOf(targetUserId, at);
    this.audits.push(audit);
    return 'INSERTED';
  }
  async revokeAssignmentGuarded(input: PlatformRevokeGuardInput): Promise<PlatformRevokeOutcome> {
    this.record('revokeAssignmentGuarded');
    const index = this.assignments.findIndex(a => a.id === input.assignmentId && a.status === 'ACTIVE');
    const current = this.assignments[index];
    if (index === -1 || current === undefined) return 'NOT_FOUND';
    const activeAdmins = this.assignments.filter(a => a.role === 'PLATFORM_ADMIN' && a.status === 'ACTIVE').length;
    if (input.role === 'PLATFORM_ADMIN' && activeAdmins <= 1) return 'LAST_ADMIN';
    this.assignments[index] = { ...current, status: 'REVOKED', revokedBy: input.revokedBy, revokeReason: input.reason, revokedAt: input.at };
    this.revokeSessionsOf(input.targetUserId, input.at);
    this.audits.push(input.successAudit);
    return 'REVOKED';
  }
  async insertAudit(record: PlatformAuditRecord): Promise<void> {
    this.record('insertAudit'); this.audits.push(record);
  }
  async listAudit(limit: number): Promise<readonly PlatformAuditRecord[]> {
    this.record('listAudit');
    return [...this.audits].sort((a, b) => b.happenedAt.getTime() - a.happenedAt.getTime()).slice(0, limit);
  }
  async readOperationSummary(operationId: string): Promise<PlatformOperationSummary | undefined> {
    this.record('readOperationSummary'); return this.summaries.get(operationId);
  }
  async readOperationRuntime(operationId: string): Promise<PlatformOperationRuntime | undefined> {
    this.record('readOperationRuntime'); return this.runtimes.get(operationId);
  }
}

@PlatformRoute()
class GuardedPlatformFixture {
  @PlatformAccess('SUPPORT') support(): void {}
  @PlatformAccess('ADMINISTRATION') administration(): void {}
  @PlatformAccess('CONSULTATION') consultation(): void {}
  @PlatformAccess('OPERATIONS') operations(): void {}
  @PlatformAccess('SELF') self(): void {}
  @PlatformAccess('PUBLIC_LOGIN') login(): void {}
  unprotected(): void {}
}

@PlatformRoute()
class MissingPolicyFixture {
  handler(): void {}
}

/** A handler that declares a platform policy on a controller that is not a platform route. */
class PolicyWithoutRouteFixture {
  @PlatformAccess('ADMINISTRATION') handler(): void {}
}

class TenantFixture {
  list(): void {}
}

interface RequestStub { headers: Record<string, string | string[] | undefined>; platformPrincipal?: PlatformPrincipal }

function contextFor(handler: (...args: never[]) => unknown, handlerClass: Function, headers: Record<string, string> = {}): { context: ExecutionContext; request: RequestStub } {
  const request: RequestStub = { headers };
  const context = {
    getHandler: () => handler,
    getClass: () => handlerClass,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { context, request };
}

interface Fixture {
  readonly repository: FakePlatformRepository;
  readonly credentials: FakeCredentials;
  readonly clock: FakeClock;
  readonly service: PlatformAdminService;
  readonly guard: PlatformAccessGuard;
}

function fixture(): Fixture {
  const repository = new FakePlatformRepository();
  const credentials = new FakeCredentials();
  const clock = new FakeClock();
  let sequence = 0;
  const service = new PlatformAdminService(repository, credentials, {
    hashToken: sha256,
    now: () => clock.value,
    generateId: () => 'id-' + String(++sequence).padStart(6, '0'),
    generateToken: () => 'platform-token-' + String(++sequence).padStart(6, '0') + '-' + 'a'.repeat(12),
  });
  const guard = new PlatformAccessGuard(new Reflector(), service);
  return { repository, credentials, clock, service, guard };
}

const owner = { userId: 'user-workspace-owner', email: 'owner@example.invalid', password: 'owner-passphrase' };
const admin = { userId: 'user-platform-admin', email: 'admin@example.invalid', password: 'admin-passphrase' };
const secondAdmin = { userId: 'user-platform-admin-two', email: 'admin2@example.invalid', password: 'admin2-passphrase' };
const support = { userId: 'user-platform-support', email: 'support@example.invalid', password: 'support-passphrase' };
const operations = { userId: 'user-platform-operations', email: 'ops@example.invalid', password: 'ops-passphrase' };
const auditor = { userId: 'user-platform-auditor', email: 'auditor@example.invalid', password: 'auditor-passphrase' };
const operationId = 'operation-qa-platform-0001';

function seed(f: Fixture): void {
  for (const account of [owner, admin, secondAdmin, support, operations, auditor]) {
    f.repository.users.set(account.userId, { id: account.userId, email: account.email, disabledAt: null });
    f.credentials.register(account.email, account.userId, account.password);
  }
  const grantedAt = new Date('2026-11-01T00:00:00.000Z');
  const assignment = (userId: string, role: PlatformRole): PlatformAssignmentRecord => ({
    id: 'assignment-' + userId + '-' + role, userId, role, status: 'ACTIVE',
    grantedBy: 'QA_FIXTURE', grantReason: 'deterministic authorization fixture',
    grantedAt, revokedBy: null, revokeReason: null, revokedAt: null,
  });
  f.repository.assignments.push(
    assignment(admin.userId, 'PLATFORM_ADMIN'),
    assignment(support.userId, 'SUPPORT'),
    assignment(operations.userId, 'OPERATIONS'),
    assignment(auditor.userId, 'AUDITOR'),
  );
  f.repository.summaries.set(operationId, {
    operationId, workspaceId: 'workspace-qa-0001', workspaceName: 'QA Workspace', title: 'QA platform operation',
    status: 'DRAFT', version: 1, createdBy: owner.userId, currentRevisionId: null,
    updatedAt: '2026-11-13T10:00:00.000Z', lastActivityAt: '2026-11-13T10:00:00.000Z',
  });
  f.repository.runtimes.set(operationId, {
    operationId,
    dispatch: [{ id: 'outbox-1', state: 'PENDING', topic: 'EXECUTE_STEP', attempts: 0, lastErrorCode: null }],
    executions: [],
    attempts: [],
  });
}


async function loginToken(f: Fixture, account: { email: string; password: string }): Promise<string> {
  const result = await f.service.login({ email: account.email, password: account.password });
  return result.token;
}

async function partA(): Promise<void> {
  const f = fixture();
  seed(f);
  const { repository, guard } = f;
  const bearer = (token: string) => 'Bearer ' + token;
  const workspaceToken = 'workspace-session-' + 'w'.repeat(20);

  // ---- role vocabulary separation -----------------------------------------------------------
  assert(isPlatformRole('PLATFORM_ADMIN') && isPlatformRole('SUPPORT') && isPlatformRole('OPERATIONS') && isPlatformRole('AUDITOR'), 'platform roles are recognized');
  for (const workspaceRole of ['OWNER', 'ADMIN', 'MEMBER', 'OPERATOR', 'REVIEWER']) {
    assert(!isPlatformRole(workspaceRole), 'workspace role ' + workspaceRole + ' is not a platform role');
  }
  assert(platformPermissionsForRoles(['PLATFORM_ADMIN']).join(',') === 'ADMINISTRATION,CONSULTATION', 'general administration holds minimum permissions');
  assert(platformPermissionsForRoles(['SUPPORT']).join(',') === 'SUPPORT', 'support holds only support');
  assert(platformPermissionsForRoles(['OPERATIONS']).join(',') === 'OPERATIONS', 'operations holds only operations');
  assert(platformPermissionsForRoles(['AUDITOR']).join(',') === 'CONSULTATION', 'consultation holds only consultation');
  assert(platformPermissionsForRoles(['SUPPORT', 'OPERATIONS']).join(',') === 'SUPPORT,OPERATIONS', 'multiple assignments union permissions without implicit consultation');

  // ---- a workspace owner cannot authenticate to the platform --------------------------------
  await expectDomainError('DENIED', () => f.service.authenticate(workspaceToken), 'workspace bearer rejected by platform service');
  assert(repository.calls.includes('findSessionByTokenHash'), 'platform authentication only reads the platform session namespace');
  assert(!repository.calls.some(call => call.toLowerCase().includes('member')), 'platform authentication never reads workspace memberships');
  const rejectedAudit = repository.audits[repository.audits.length - 1];
  assert(rejectedAudit !== undefined && rejectedAudit.outcome === 'DENIED' && rejectedAudit.action === 'AUTHENTICATE', 'unknown-session denial is audited');

  const sessionsBefore = repository.sessions.length;
  await expectDomainError('DENIED', () => f.service.login({ email: owner.email, password: owner.password }), 'workspace owner credentials hold no platform assignment');
  assert(repository.sessions.length === sessionsBefore, 'no platform session is issued to a workspace owner');
  const noAssignmentAudit = repository.audits[repository.audits.length - 1];
  assert(noAssignmentAudit !== undefined && noAssignmentAudit.outcome === 'DENIED' && noAssignmentAudit.reason === 'NO_ACTIVE_PLATFORM_ASSIGNMENT' && noAssignmentAudit.targetId === owner.userId, 'missing platform assignment is audited with target');
  await expectDomainError('DENIED', () => f.service.login({ email: owner.email, password: 'wrong-password' }), 'wrong password rejected');

  // ---- platform login and session -----------------------------------------------------------
  const adminLogin = await f.service.login({ email: admin.email, password: admin.password });
  assert(adminLogin.roles.join(',') === 'PLATFORM_ADMIN', 'platform account receives its platform role only');
  assert(adminLogin.permissions.join(',') === 'ADMINISTRATION,CONSULTATION', 'general administration does not absorb support or operations');
  const storedSession = repository.sessions[repository.sessions.length - 1];
  assert(storedSession !== undefined && storedSession.tokenHash === sha256(adminLogin.token) && storedSession.tokenHash !== adminLogin.token, 'platform session stores only a SHA-256 token digest');
  const loginAudit = repository.audits[repository.audits.length - 1];
  assert(loginAudit !== undefined && loginAudit.action === 'LOGIN' && loginAudit.outcome === 'SUCCESS' && loginAudit.actorUserId === admin.userId && loginAudit.actorSessionId === storedSession.id, 'successful platform login is audited with actor and session');

  const adminPrincipal = await f.service.authenticate(adminLogin.token);
  assert(adminPrincipal.roles.join(',') === 'PLATFORM_ADMIN', 'platform bearer resolves platform roles');
  assert(adminPrincipal.userId === admin.userId, 'platform principal carries the identity user id');
  assert(repository.calls.includes('touchSession'), 'platform session last-used time is tracked');
  assert(f.service.me(adminPrincipal).permissions.join(',') === 'ADMINISTRATION,CONSULTATION', 'session info exposes the same minimum permissions');
  await expectDomainError('DENIED', () => f.service.authenticate('short-token'), 'malformed platform token is rejected');

  // ---- guard: workspace authority is never enough ------------------------------------------
  await expectDomainError('DENIED', () => guard.canActivate(contextFor(GuardedPlatformFixture.prototype.administration, GuardedPlatformFixture).context), 'platform route requires a platform bearer');
  const missingSessionAudit = repository.audits[repository.audits.length - 1];
  assert(missingSessionAudit !== undefined && missingSessionAudit.action === 'PLATFORM_ACCESS' && missingSessionAudit.reason === 'MISSING_SESSION' && missingSessionAudit.actorUserId === null, 'missing platform bearer is denied and audited without an actor');
  const workspaceCtx = contextFor(GuardedPlatformFixture.prototype.administration, GuardedPlatformFixture, { authorization: bearer(workspaceToken) });
  await expectDomainError('DENIED', () => guard.canActivate(workspaceCtx.context), 'workspace bearer rejected by the platform guard');
  assert(workspaceCtx.request.platformPrincipal === undefined, 'a denied request receives no platform principal');

  const supportToken = await loginToken(f, support);
  const supportCtx = contextFor(GuardedPlatformFixture.prototype.administration, GuardedPlatformFixture, { authorization: bearer(supportToken) });
  await expectDomainError('DENIED', () => guard.canActivate(supportCtx.context), 'support cannot access administration');
  const guardDenial = repository.audits[repository.audits.length - 1];
  assert(guardDenial !== undefined && guardDenial.action === 'PLATFORM_ACCESS' && guardDenial.permission === 'ADMINISTRATION' && guardDenial.outcome === 'DENIED' && guardDenial.actorUserId === support.userId, 'guard denial is audited with actor and required permission');

  const adminCtx = contextFor(GuardedPlatformFixture.prototype.administration, GuardedPlatformFixture, { authorization: bearer(adminLogin.token) });
  assert(await guard.canActivate(adminCtx.context) === true, 'administration permission opens administration routes');
  assert(adminCtx.request.platformPrincipal?.userId === admin.userId, 'authorized request receives the platform principal');
  await expectDomainError('DENIED', () => guard.canActivate(contextFor(GuardedPlatformFixture.prototype.support, GuardedPlatformFixture, { authorization: bearer(adminLogin.token) }).context), 'general administration cannot absorb support');
  assert(await guard.canActivate(contextFor(GuardedPlatformFixture.prototype.self, GuardedPlatformFixture, { authorization: bearer(supportToken) }).context) === true, 'SELF route accepts any valid platform session');
  assert(await guard.canActivate(contextFor(GuardedPlatformFixture.prototype.login, GuardedPlatformFixture).context) === true, 'public platform login route needs no session');
  await expectDomainError('DENIED', () => guard.canActivate(contextFor(MissingPolicyFixture.prototype.handler, MissingPolicyFixture).context), 'platform route without declared policy fails closed');
  const missingPolicyAudit = repository.audits[repository.audits.length - 1];
  assert(missingPolicyAudit !== undefined && missingPolicyAudit.reason === 'MISSING_ACCESS_POLICY' && missingPolicyAudit.outcome === 'DENIED', 'missing access policy is denied and audited');
  await expectDomainError('DENIED', () => guard.canActivate(contextFor(PolicyWithoutRouteFixture.prototype.handler, PolicyWithoutRouteFixture).context), '@PlatformAccess without @PlatformRoute fails closed');
  await expectDomainError('DENIED', () => guard.canActivate(contextFor(GuardedPlatformFixture.prototype.unprotected, GuardedPlatformFixture, { authorization: bearer(adminLogin.token) }).context), 'undeclared platform handler fails closed even with a valid session');
  assert(await guard.canActivate(contextFor(TenantFixture.prototype.list, TenantFixture).context) === true, 'guard ignores non-platform routes');

  // ---- explicit assignment mechanism -------------------------------------------------------
  const supportPrincipal = await f.service.authenticate(supportToken);
  await expectDomainError('DENIED', () => f.service.listAssignments(supportPrincipal), 'support cannot consult the administrator list');
  await expectDomainError('DENIED', () => f.service.listAudit(supportPrincipal, 5), 'support cannot read the audit trail');
  await expectDomainError('DENIED', () => f.service.assign({ actor: supportPrincipal, targetUserId: owner.userId, role: 'AUDITOR', reason: 'support must not grant roles' }), 'support cannot assign platform roles');
  await expectDomainError('DENIED', () => f.service.revoke({ actor: supportPrincipal, targetUserId: admin.userId, role: 'PLATFORM_ADMIN', reason: 'support must not revoke roles' }), 'support cannot revoke platform roles');
  await expectDomainError('NOT_FOUND', () => f.service.assign({ actor: adminPrincipal, targetUserId: 'user-does-not-exist', role: 'SUPPORT', reason: 'unknown target user' }), 'assignment to unknown identity is refused');
  await expectDomainError('INVALID_INPUT', () => f.service.assign({ actor: adminPrincipal, targetUserId: owner.userId, role: 'OWNER' as unknown as PlatformRole, reason: 'workspace role is not a platform role' }), 'workspace role cannot be assigned as a platform role');
  await expectDomainError('INVALID_INPUT', () => f.service.assign({ actor: adminPrincipal, targetUserId: owner.userId, role: 'SUPPORT', reason: 'no' }), 'assignment reason is validated');
  assert(!repository.assignments.some(a => a.userId === owner.userId), 'refused assignments create no row');

  const seededOwnerSession: PlatformSessionRecord = {
    id: 'seeded-owner-session', userId: owner.userId,
    tokenHash: sha256('owner-platform-token-' + 'o'.repeat(20)),
    expiresAt: new Date('2026-11-14T00:00:00.000Z'), revokedAt: null,
    createdAt: new Date('2026-11-13T00:00:00.000Z'), lastUsedAt: null,
  };
  repository.sessions.push(seededOwnerSession);
  const granted = await f.service.assign({ actor: adminPrincipal, targetUserId: owner.userId, role: 'SUPPORT', reason: 'explicit support assignment for QA' });
  assert(granted.status === 'ACTIVE' && granted.userId === owner.userId && granted.role === 'SUPPORT' && granted.grantedBy === admin.userId, 'explicit assignment records actor, target and role');
  const seededOwnerSessionAfter = repository.sessions.find(s => s.id === seededOwnerSession.id);
  assert(seededOwnerSessionAfter !== undefined && seededOwnerSessionAfter.revokedAt !== null, 'assignment change revokes the target platform sessions');
  const assignAudit = repository.audits[repository.audits.length - 1];
  assert(assignAudit !== undefined && assignAudit.action === 'ASSIGN_PLATFORM_ROLE' && assignAudit.outcome === 'SUCCESS' && assignAudit.targetId === granted.id && assignAudit.actorUserId === admin.userId && assignAudit.permission === 'ADMINISTRATION', 'successful assignment is audited');
  await expectDomainError('CONFLICT', () => f.service.assign({ actor: adminPrincipal, targetUserId: owner.userId, role: 'SUPPORT', reason: 'duplicate assignment' }), 'duplicate platform assignment is refused');

  const ownerPlatformLogin = await f.service.login({ email: owner.email, password: owner.password });
  assert(ownerPlatformLogin.roles.join(',') === 'SUPPORT', 'a workspace owner gains only an explicitly assigned platform role');
  assert(ownerPlatformLogin.permissions.join(',') === 'SUPPORT', 'the explicitly assigned permission set is minimal');
  assert(!ownerPlatformLogin.permissions.includes('ADMINISTRATION'), 'explicit support assignment does not grant administration');
  const ownerPlatformPrincipal = await f.service.authenticate(ownerPlatformLogin.token);
  await expectDomainError('DENIED', () => f.service.listAssignments(ownerPlatformPrincipal), 'explicit support assignment does not grant consultation');
  await expectDomainError('DENIED', () => guard.canActivate(contextFor(GuardedPlatformFixture.prototype.administration, GuardedPlatformFixture, { authorization: bearer(ownerPlatformLogin.token) }).context), 'workspace owner with support assignment still cannot access administration');

  const revokedAssignment = await f.service.revoke({ actor: adminPrincipal, targetUserId: owner.userId, role: 'SUPPORT', reason: 'QA revocation check' });
  assert(revokedAssignment.status === 'REVOKED' && revokedAssignment.revokedBy === admin.userId && revokedAssignment.revokedAt !== null, 'revocation records actor and time');
  await expectDomainError('DENIED', () => f.service.authenticate(ownerPlatformLogin.token), 'revocation invalidates the target platform session');
  await expectDomainError('DENIED', () => f.service.login({ email: owner.email, password: owner.password }), 'revoked assignment blocks future platform login');
  await expectDomainError('NOT_FOUND', () => f.service.revoke({ actor: adminPrincipal, targetUserId: auditor.userId, role: 'SUPPORT', reason: 'not assigned role' }), 'revocation of a missing assignment is refused');

  // ---- last administrator protection -------------------------------------------------------
  await expectDomainError('DENIED', () => f.service.revoke({ actor: adminPrincipal, targetUserId: admin.userId, role: 'PLATFORM_ADMIN', reason: 'last admin must remain' }), 'the last platform administrator cannot be revoked');
  const lastAdminAudit = repository.audits[repository.audits.length - 1];
  assert(lastAdminAudit !== undefined && lastAdminAudit.outcome === 'DENIED' && lastAdminAudit.reason === 'LAST_PLATFORM_ADMIN', 'last-administrator denial is audited');
  await f.service.assign({ actor: adminPrincipal, targetUserId: secondAdmin.userId, role: 'PLATFORM_ADMIN', reason: 'second administrator for QA' });
  const secondAdminToken = await loginToken(f, secondAdmin);
  const secondAdminPrincipal = await f.service.authenticate(secondAdminToken);
  const adminRevoked = await f.service.revoke({ actor: secondAdminPrincipal, targetUserId: admin.userId, role: 'PLATFORM_ADMIN', reason: 'rotate administration ownership' });
  assert(adminRevoked.status === 'REVOKED', 'an administrator can be revoked while another remains');
  await expectDomainError('DENIED', () => f.service.authenticate(adminLogin.token), 'revoked administrator session is invalidated');
  const remainingAdmins = repository.assignments.filter(a => a.role === 'PLATFORM_ADMIN' && a.status === 'ACTIVE').length;
  assert(remainingAdmins === 1, 'exactly one platform administrator remains');

  // ---- consultation, support and operations reads ------------------------------------------
  const auditorToken = await loginToken(f, auditor);
  const auditorPrincipal = await f.service.authenticate(auditorToken);
  const assignmentsView = await f.service.listAssignments(auditorPrincipal);
  assert(assignmentsView.length >= 2 && assignmentsView.every(row => typeof row.grantedAt === 'string'), 'auditor can consult platform assignments');
  const auditView = await f.service.listAudit(auditorPrincipal, 10);
  assert(auditView.length > 0, 'auditor can consult the audit trail');
  const firstAudit = auditView[0];
  assert(firstAudit !== undefined && typeof firstAudit.id === 'string' && typeof firstAudit.action === 'string' && (firstAudit.outcome === 'SUCCESS' || firstAudit.outcome === 'DENIED') && typeof firstAudit.happenedAt === 'string' && (typeof firstAudit.actorUserId === 'string' || firstAudit.actorUserId === null), 'audit rows expose actor, action, date and result');
  const readAuditRow = repository.audits[repository.audits.length - 1];
  assert(readAuditRow !== undefined && readAuditRow.action === 'LIST_PLATFORM_AUDIT' && readAuditRow.outcome === 'SUCCESS', 'reading the audit trail is itself audited');

  const supportPrincipalFresh = await f.service.authenticate(supportToken);
  const summary = await f.service.readSupportOperation(supportPrincipalFresh, operationId);
  assert(summary.workspaceId === 'workspace-qa-0001' && summary.title === 'QA platform operation', 'support reads cross-workspace operation diagnostics');
  await expectDomainError('DENIED', () => f.service.readOperationRuntime(supportPrincipalFresh, operationId), 'support cannot read technical runtime');
  const operationsToken = await loginToken(f, operations);
  const operationsPrincipal = await f.service.authenticate(operationsToken);
  await expectDomainError('DENIED', () => f.service.listAssignments(operationsPrincipal), 'operations cannot consult the administrator list');
  await expectDomainError('DENIED', () => f.service.listAudit(operationsPrincipal, 5), 'operations cannot read the audit trail');
  const runtime = await f.service.readOperationRuntime(operationsPrincipal, operationId);
  assert(runtime.dispatch.length === 1 && runtime.dispatch[0]?.state === 'PENDING', 'operations reads technical runtime state');
  await expectDomainError('DENIED', () => f.service.readSupportOperation(operationsPrincipal, operationId), 'operations cannot use customer-support diagnostics');
  await expectDomainError('NOT_FOUND', () => f.service.readSupportOperation(supportPrincipalFresh, 'operation-missing-0001'), 'unknown operation is not disclosed');
  const notFoundAudit = repository.audits[repository.audits.length - 1];
  assert(notFoundAudit !== undefined && notFoundAudit.outcome === 'DENIED' && notFoundAudit.reason === 'OPERATION_NOT_FOUND', 'unknown-operation denial is audited');

  // ---- audit completeness and defensive cases ----------------------------------------------
  assert(repository.audits.every(row => row.id.length > 0 && row.targetType.length > 0 && row.action.length > 0 && (row.outcome === 'SUCCESS' || row.outcome === 'DENIED' || row.outcome === 'ERROR') && row.happenedAt instanceof Date), 'every audit row carries target, action, result and date');
  assert(repository.audits.some(row => row.outcome === 'SUCCESS') && repository.audits.some(row => row.outcome === 'DENIED'), 'both successful and denied outcomes are recorded');

  await f.service.recordAccessDenial({ action: 'PLATFORM_ACCESS', targetType: 'PLATFORM_ROUTE', targetId: 'qa-fixture', reason: 'QA_PRE_AUTH_DENIAL' });
  const preAuthDenial = repository.audits[repository.audits.length - 1];
  assert(preAuthDenial !== undefined && preAuthDenial.outcome === 'DENIED' && preAuthDenial.actorUserId === null && preAuthDenial.reason === 'QA_PRE_AUTH_DENIAL', 'pre-authentication denial is recorded without an actor');
  await f.service.recordInputRejection(secondAdminPrincipal, { action: 'ASSIGN_PLATFORM_ROLE', targetType: 'PLATFORM_ASSIGNMENT' });
  const rejectionRow = repository.audits[repository.audits.length - 1];
  assert(rejectionRow !== undefined && rejectionRow.outcome === 'DENIED' && rejectionRow.reason === 'INVALID_INPUT' && rejectionRow.actorUserId === secondAdmin.userId, 'validation rejection is audited with the actor');

  const operationsUser = repository.users.get(operations.userId);
  assert(operationsUser !== undefined, 'seeded operations user exists');
  operationsUser.disabledAt = new Date('2026-11-13T00:00:00.000Z');
  await expectDomainError('DENIED', () => f.service.login({ email: operations.email, password: operations.password }), 'a disabled identity account cannot open a platform session');
  operationsUser.disabledAt = null;

  repository.assignments.push({
    id: 'tampered-workspace-role', userId: auditor.userId, role: 'OWNER' as unknown as PlatformRole, status: 'ACTIVE',
    grantedBy: 'QA_TAMPER', grantReason: 'simulated workspace role leak', grantedAt: new Date(),
    revokedBy: null, revokeReason: null, revokedAt: null,
  });
  await expectDomainError('INVALID_STATE', () => f.service.login({ email: auditor.email, password: auditor.password }), 'a stored workspace role is rejected instead of granting platform authority');
  const tamperedIndex = repository.assignments.findIndex(a => a.id === 'tampered-workspace-role');
  if (tamperedIndex >= 0) repository.assignments.splice(tamperedIndex, 1);

  // ---- session expiry and logout -----------------------------------------------------------
  assert((await f.service.authenticate(auditorToken)).roles.join(',') === 'AUDITOR', 'auditor session valid before the expiry check');
  f.clock.advance(9 * 60 * 60 * 1000);
  await expectDomainError('DENIED', () => f.service.authenticate(auditorToken), 'expired platform session is rejected');
  const expiredAudit = repository.audits[repository.audits.length - 1];
  assert(expiredAudit !== undefined && expiredAudit.reason === 'EXPIRED_SESSION', 'expired-session denial reason is audited');
  f.clock.advance(-9 * 60 * 60 * 1000);
  await f.service.logout(supportPrincipalFresh);
  await expectDomainError('DENIED', () => f.service.authenticate(supportToken), 'logout revokes the platform session');
  const logoutAudit = repository.audits[repository.audits.length - 2];
  assert(logoutAudit !== undefined && logoutAudit.action === 'LOGOUT' && logoutAudit.outcome === 'SUCCESS', 'logout is audited');

  console.log('  part A authorization invariants: OK');
}


interface HttpResult { readonly status: number; readonly body: unknown }

async function partB(): Promise<void> {
  // No PostgreSQL is required for these requests: every denial happens in the guards before any
  // query. The dummy URL proves the wiring does not depend on a reachable database.
  process.env.DATABASE_URL = 'postgresql://qeynox:qeynox@127.0.0.1:1/qeynox_platform_wiring';
  const app = await NestFactory.create(AppModule, { logger: false });
  app.useGlobalFilters(new DomainExceptionFilter());
  await app.listen(0, '127.0.0.1');
  try {
    const address = app.getHttpServer().address() as { port: number };
    assert(Number.isInteger(address.port) && address.port > 0, 'API boots for HTTP wiring checks');
    const base = 'http://127.0.0.1:' + address.port;
    const call = async (path: string, init: RequestInit = {}): Promise<HttpResult> => {
      const response = await fetch(base + path, init);
      const text = await response.text();
      let body: unknown = text;
      try { body = JSON.parse(text) as unknown; } catch { /* plain text body */ }
      return { status: response.status, body };
    };
    const errorCode = (result: HttpResult): string | undefined => (result.body as { error?: { code?: string } }).error?.code;
    const postJson = (body: string): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body });

    const health = await call('/health');
    assert(health.status === 200, 'public health route still served');

    const protectedRoutes: ReadonlyArray<readonly [string, 'GET' | 'POST']> = [
      ['/v1/platform/admins', 'GET'],
      ['/v1/platform/audit', 'GET'],
      ['/v1/platform/admins/user-unknown-0001/assign', 'POST'],
      ['/v1/platform/admins/user-unknown-0001/revoke', 'POST'],
      ['/v1/platform/support/operations/operation-unknown-0001', 'GET'],
      ['/v1/platform/operations/operation-unknown-0001/runtime', 'GET'],
      ['/v1/platform/auth/me', 'GET'],
      ['/v1/platform/auth/logout', 'POST'],
    ];
    for (const [path, method] of protectedRoutes) {
      const result = await call(path, method === 'GET' ? {} : postJson('{}'));
      assert(result.status === 403 && errorCode(result) === 'DENIED', 'platform route ' + method + ' ' + path + ' is protected without a platform session');
    }

    const loginEmpty = await call('/v1/platform/auth/login', postJson('{}'));
    assert(loginEmpty.status === 400 && errorCode(loginEmpty) === 'INVALID_INPUT', 'public platform login route is reachable and validates input before any credential lookup');

    const workspaceRoute = await call('/v1/operations');
    assert(workspaceRoute.status === 403 && errorCode(workspaceRoute) === 'DENIED', 'workspace routes still require a workspace session');
    const workspaceLoginEmpty = await call('/v1/auth/login', postJson('{}'));
    assert(workspaceLoginEmpty.status === 400 && errorCode(workspaceLoginEmpty) === 'INVALID_INPUT', 'existing workspace login route is unchanged');
    console.log('  part B HTTP wiring and protection: OK');
  } finally {
    await app.close();
  }
}


async function main(): Promise<void> {
  await partA();
  const beforeB = assertions;
  await partB();
  console.log('Part B assertions:', assertions - beforeB);
  console.log('Platform administration authorization PASSED:', assertions, 'assertions; no database required.');
}

main().catch((error: unknown) => {
  console.error('Platform administration authorization FAILED:', error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});

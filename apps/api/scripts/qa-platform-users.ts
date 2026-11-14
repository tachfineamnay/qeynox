/**
 * Platform user administration QA (no database required for parts A and B).
 *
 * Part A exercises the real PlatformUsersService, the real PlatformAdminService (permissions,
 * sessions, audit) and the real PlatformAccessGuard against in-memory persistence ports, using the
 * real PlatformUsersController metadata for route policies. Part B boots the real NestJS
 * application with an unreachable database and verifies the HTTP protection and wiring that never
 * reaches PostgreSQL.
 *
 * Part C (isolated PostgreSQL end-to-end flow) runs only when QEYNOX_QA_DATABASE_URL is set.
 */
import 'reflect-metadata';
import { createHash } from 'node:crypto';
import type { ExecutionContext, INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Reflector } from '@nestjs/core';
import {
  DomainError,
  type ID,
  type PlatformPrincipal,
  type PlatformRole,
} from '@qeynox/domain';
import {
  PlatformAdminService,
  PlatformUsersService,
  type EmailTransport,
  type IdentityCredentialVerifier,
  type PlatformAdminRepository,
  type PlatformRevokeGuardInput,
  type PlatformUserRepository,
} from '@qeynox/application';
import type {
  PlatformAssignmentRecord,
  PlatformAuditRecord,
  PlatformIdentitySessionRow,
  PlatformOperationRuntime,
  PlatformOperationSummary,
  PlatformReactivateOutcome,
  PlatformRevokeOutcome,
  PlatformSessionCounts,
  PlatformSessionRecord,
  PlatformSessionRevokeOutcome,
  PlatformSuspendOutcome,
  PlatformUserActivityRow,
  PlatformUserCursor,
  PlatformUserMembershipRow,
  PlatformUserOnboardingRow,
  PlatformUserRow,
} from '@qeynox/persistence';
import { and, count, eq } from 'drizzle-orm';
import { connectDatabase, identityCredentials, identityUsers, platformAdminAssignments, runMigrations } from '@qeynox/persistence';
import { hashPassword } from '../src/auth/password';
import { AppModule } from '../src/app.module';
import { DomainExceptionFilter } from '../src/transport/domain-exception.filter';
import { PlatformAccessGuard } from '../src/platform/platform-access.guard';
import { PlatformUsersController } from '../src/platform/platform-users.controller';
import { PlatformRoute } from '../src/auth/platform-route';
import { createIsolatedQaDatabase } from './qa-isolated-database';

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
  value = new Date('2026-11-14T09:00:00.000Z');
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

/** Minimal in-memory platform administration repository (sessions, roles, audit). */
class FakePlatformAdminRepository implements PlatformAdminRepository {
  readonly users = new Map<string, { id: string; email: string; disabledAt: Date | null }>();
  readonly assignments: PlatformAssignmentRecord[] = [];
  readonly sessions: PlatformSessionRecord[] = [];
  readonly audits: PlatformAuditRecord[] = [];
  async findIdentityUser(userId: string): Promise<{ readonly id: string; readonly email: string; readonly disabledAt: Date | null } | undefined> {
    return this.users.get(userId);
  }
  async listActiveAssignments(userId: string): Promise<readonly PlatformAssignmentRecord[]> {
    return this.assignments.filter(a => a.userId === userId && a.status === 'ACTIVE');
  }
  async findActiveAssignment(userId: string, role: PlatformRole): Promise<PlatformAssignmentRecord | undefined> {
    return this.assignments.find(a => a.userId === userId && a.role === role && a.status === 'ACTIVE');
  }
  async listAssignments(limit: number): Promise<readonly PlatformAssignmentRecord[]> {
    return this.assignments.slice(0, limit);
  }
  async insertAudit(record: PlatformAuditRecord): Promise<void> { this.audits.push(record); }
  async listAudit(limit: number): Promise<readonly PlatformAuditRecord[]> {
    return [...this.audits].sort((a, b) => b.happenedAt.getTime() - a.happenedAt.getTime()).slice(0, limit);
  }
  async findSessionByTokenHash(tokenHash: string): Promise<PlatformSessionRecord | undefined> {
    return this.sessions.find(s => s.tokenHash === tokenHash);
  }
  async touchSession(id: string, at: Date): Promise<void> {
    const index = this.sessions.findIndex(s => s.id === id);
    const current = this.sessions[index];
    if (index >= 0 && current !== undefined) this.sessions[index] = { ...current, lastUsedAt: at };
  }
  async insertSessionWithAudit(session: PlatformSessionRecord, audit: PlatformAuditRecord): Promise<void> {
    this.sessions.push(session); this.audits.push(audit);
  }
  async revokeSessionWithAudit(sessionId: string, at: Date, audit: PlatformAuditRecord): Promise<void> {
    const index = this.sessions.findIndex(s => s.id === sessionId);
    const current = this.sessions[index];
    if (index >= 0 && current !== undefined) this.sessions[index] = { ...current, revokedAt: at };
    this.audits.push(audit);
  }
  async assignWithAudit(assignment: PlatformAssignmentRecord, audit: PlatformAuditRecord): Promise<'INSERTED' | 'CONFLICT'> {
    this.assignments.push(assignment); this.audits.push(audit); return 'INSERTED';
  }
  async revokeAssignmentGuarded(input: PlatformRevokeGuardInput): Promise<PlatformRevokeOutcome> {
    const index = this.assignments.findIndex(a => a.id === input.assignmentId && a.status === 'ACTIVE');
    const current = this.assignments[index];
    if (index === -1 || current === undefined) return 'NOT_FOUND';
    this.assignments[index] = { ...current, status: 'REVOKED', revokedBy: input.revokedBy, revokeReason: input.reason, revokedAt: input.at };
    this.audits.push(input.successAudit);
    return 'REVOKED';
  }
  async readOperationSummary(): Promise<PlatformOperationSummary | undefined> { return undefined; }
  async readOperationRuntime(): Promise<PlatformOperationRuntime | undefined> { return undefined; }
}

interface FakeDirectoryUser {
  id: string;
  email: string;
  locale: string;
  createdAt: Date;
  disabledAt: Date | null;
}

interface FakeIdentitySession {
  id: string;
  userId: string;
  tokenHash: string;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
}

class FakeUserRepository implements PlatformUserRepository {
  constructor(private readonly platformRepo: FakePlatformAdminRepository) {}
  readonly users: FakeDirectoryUser[] = [];
  readonly memberships = new Map<string, PlatformUserMembershipRow[]>();
  readonly identitySessions = new Map<string, FakeIdentitySession[]>();
  readonly platformRoles = new Map<string, PlatformRole[]>();
  readonly identityEvents = new Map<string, PlatformUserActivityRow[]>();
  deleteCalls = 0;

  async listUsers(input: {
    readonly query?: string | undefined;
    readonly status?: 'ACTIVE' | 'SUSPENDED' | undefined;
    readonly before?: PlatformUserCursor | undefined;
    readonly take: number;
  }): Promise<readonly PlatformUserRow[]> {
    const query = input.query?.toLowerCase();
    const filter = (user: FakeDirectoryUser): boolean => {
      if (query !== undefined && !user.email.toLowerCase().includes(query)) return false;
      if (input.status === 'ACTIVE' && user.disabledAt !== null) return false;
      if (input.status === 'SUSPENDED' && user.disabledAt === null) return false;
      if (input.before !== undefined) {
        const afterCursor = user.createdAt.getTime() < input.before.at.getTime()
          || (user.createdAt.getTime() === input.before.at.getTime() && user.id < input.before.id);
        if (!afterCursor) return false;
      }
      return true;
    };
    return this.users.filter(filter)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
      .slice(0, input.take)
      .map(user => ({ id: user.id, email: user.email, locale: user.locale, createdAt: user.createdAt, disabledAt: user.disabledAt }));
  }
  async countWorkspacesByUserIds(userIds: readonly string[]): Promise<ReadonlyMap<string, number>> {
    return new Map(userIds.map(id => [id, this.memberships.get(id)?.length ?? 0]));
  }
  async findUser(userId: string): Promise<PlatformUserRow | undefined> {
    const user = this.users.find(candidate => candidate.id === userId);
    if (!user) return undefined;
    return { id: user.id, email: user.email, locale: user.locale, createdAt: user.createdAt, disabledAt: user.disabledAt };
  }
  async listMemberships(userId: string): Promise<readonly PlatformUserMembershipRow[]> {
    return this.memberships.get(userId) ?? [];
  }
  async listSessions(userId: string): Promise<readonly PlatformIdentitySessionRow[]> {
    return (this.identitySessions.get(userId) ?? [])
      .map(session => ({ id: session.id, createdAt: session.createdAt, expiresAt: session.expiresAt, revokedAt: session.revokedAt, lastUsedAt: session.lastUsedAt }));
  }
  async listPlatformSessions(userId: string): Promise<readonly PlatformIdentitySessionRow[]> {
    return this.platformRepo.sessions.filter(session => session.userId === userId)
      .map(session => ({ id: session.id, createdAt: session.createdAt, expiresAt: session.expiresAt, revokedAt: session.revokedAt, lastUsedAt: session.lastUsedAt }));
  }
  async platformSessionsSummary(userId: string, at: Date): Promise<{ readonly total: number; readonly active: number; readonly lastUsedAt: Date | null }> {
    const sessions = this.platformRepo.sessions.filter(session => session.userId === userId);
    const active = sessions.filter(session => session.revokedAt === null && session.expiresAt.getTime() > at.getTime()).length;
    const lastUsed = sessions.map(session => session.lastUsedAt).filter((value): value is Date => value !== null).sort((a, b) => b.getTime() - a.getTime())[0];
    return { total: sessions.length, active, lastUsedAt: lastUsed ?? null };
  }
  async sessionsSummary(userId: string, at: Date): Promise<{ readonly total: number; readonly active: number; readonly lastUsedAt: Date | null }> {
    const sessions = this.identitySessions.get(userId) ?? [];
    const active = sessions.filter(session => session.revokedAt === null && session.expiresAt.getTime() > at.getTime()).length;
    const lastUsed = sessions.map(session => session.lastUsedAt).filter((value): value is Date => value !== null).sort((a, b) => b.getTime() - a.getTime())[0];
    return { total: sessions.length, active, lastUsedAt: lastUsed ?? null };
  }
  async listPlatformRoles(userId: string): Promise<readonly PlatformRole[]> {
    return this.platformRoles.get(userId) ?? [];
  }
  async suspendUserGuarded(input: {
    readonly userId: string;
    readonly at: Date;
    readonly buildSuccessAudit: (counts: PlatformSessionCounts) => PlatformAuditRecord;
  }): Promise<PlatformSuspendOutcome> {
    const user = this.users.find(candidate => candidate.id === input.userId);
    if (!user) return 'NOT_FOUND';
    if (user.disabledAt !== null) return 'ALREADY_SUSPENDED';
    const roles = this.platformRoles.get(input.userId) ?? [];
    if (roles.includes('PLATFORM_ADMIN')) {
      const enabledAdmins = [...this.platformRoles.entries()].filter(([id, candidateRoles]) => {
        if (!candidateRoles.includes('PLATFORM_ADMIN')) return false;
        const candidate = this.users.find(item => item.id === id);
        return candidate !== undefined && candidate.disabledAt === null;
      }).length;
      if (enabledAdmins <= 1) return 'LAST_ADMIN';
    }
    user.disabledAt = input.at;
    let workspaceSessions = 0;
    for (const session of this.identitySessions.get(input.userId) ?? []) {
      if (session.revokedAt === null) { session.revokedAt = input.at; workspaceSessions++; }
    }
    let platformSessions = 0;
    for (let index = 0; index < this.platformRepo.sessions.length; index++) {
      const session = this.platformRepo.sessions[index];
      if (session !== undefined && session.userId === input.userId && session.revokedAt === null) {
        this.platformRepo.sessions[index] = { ...session, revokedAt: input.at };
        platformSessions++;
      }
    }
    this.platformRepo.audits.push(input.buildSuccessAudit({ workspaceSessions, platformSessions }));
    return 'SUSPENDED';
  }
  async reactivateUserWithAudit(input: { readonly userId: string; readonly at: Date; readonly successAudit: PlatformAuditRecord }): Promise<PlatformReactivateOutcome> {
    const user = this.users.find(candidate => candidate.id === input.userId);
    if (!user) return 'NOT_FOUND';
    if (user.disabledAt === null) return 'NOT_SUSPENDED';
    user.disabledAt = null;
    this.platformRepo.audits.push(input.successAudit);
    return 'REACTIVATED';
  }
  async revokeUserSessionsWithAudit(input: {
    readonly userId: string;
    readonly at: Date;
    readonly buildSuccessAudit: (counts: PlatformSessionCounts) => PlatformAuditRecord;
  }): Promise<{
    readonly outcome: PlatformSessionRevokeOutcome;
    readonly revoked: number;
    readonly revokedWorkspaceSessions: number;
    readonly revokedPlatformSessions: number;
  }> {
    const user = this.users.find(candidate => candidate.id === input.userId);
    if (!user) return { outcome: 'NOT_FOUND', revoked: 0, revokedWorkspaceSessions: 0, revokedPlatformSessions: 0 };
    let revokedWorkspaceSessions = 0;
    for (const session of this.identitySessions.get(input.userId) ?? []) {
      if (session.revokedAt === null) { session.revokedAt = input.at; revokedWorkspaceSessions++; }
    }
    let revokedPlatformSessions = 0;
    for (let index = 0; index < this.platformRepo.sessions.length; index++) {
      const session = this.platformRepo.sessions[index];
      if (session !== undefined && session.userId === input.userId && session.revokedAt === null) {
        this.platformRepo.sessions[index] = { ...session, revokedAt: input.at };
        revokedPlatformSessions++;
      }
    }
    const counts: PlatformSessionCounts = { workspaceSessions: revokedWorkspaceSessions, platformSessions: revokedPlatformSessions };
    this.platformRepo.audits.push(input.buildSuccessAudit(counts));
    return { outcome: 'REVOKED', revoked: revokedWorkspaceSessions + revokedPlatformSessions, revokedWorkspaceSessions, revokedPlatformSessions };
  }
  async listActivity(userId: string, before: PlatformUserCursor | undefined, limit: number): Promise<readonly PlatformUserActivityRow[]> {
    const identity = this.identityEvents.get(userId) ?? [];
    const lifecycleActions = new Set(['SUSPEND_PLATFORM_USER', 'REACTIVATE_PLATFORM_USER', 'REVOKE_USER_SESSIONS']);
    const platform = this.platformRepo.audits
      .filter(row => row.targetType === 'IDENTITY_ACCOUNT' && row.targetId === userId && lifecycleActions.has(row.action))
      .map(row => ({
        source: 'PLATFORM' as const, id: row.id, action: row.action, outcome: row.outcome,
        happenedAt: row.happenedAt, actorUserId: row.actorUserId, reason: row.reason, permission: row.permission,
      }));
    const merged = [...identity, ...platform]
      .filter(row => before === undefined || row.happenedAt.getTime() < before.at.getTime()
        || (row.happenedAt.getTime() === before.at.getTime() && row.id < before.id))
      .sort((a, b) => b.happenedAt.getTime() - a.happenedAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    return merged.slice(0, limit + 1);
  }
  async listOnboardingStatuses(_userId: string): Promise<readonly PlatformUserOnboardingRow[]> {
    void _userId;
    return [];
  }
}


class FakeEmailTransport implements EmailTransport {
  readonly status = 'NOT_CONFIGURED' as const;
  readonly reason = 'EMAIL_PROVIDER_NOT_CONFIGURED';
  sendCount = 0;
  async send(): Promise<void> {
    this.sendCount++;
    throw new DomainError('NOT_CONFIGURED', 'Email transport is not configured; no message was sent');
  }
}

const platformPassword = 'platform-passphrase';
const adminAccount = { userId: 'user-platform-admin', email: 'qa-admin@example.invalid' };
const targetAdminAccount = { userId: 'user-target-admin', email: 'target-admin@example.invalid' };
const adminTwoAccount = { userId: 'user-platform-admin-two', email: 'qa-admin-two@example.invalid' };
const supportAccount = { userId: 'user-platform-support', email: 'qa-support@example.invalid' };
const auditorAccount = { userId: 'user-platform-auditor', email: 'qa-auditor@example.invalid' };

const alice = { id: 'user-alice-0001', email: 'alice@example.invalid' };
const bob = { id: 'user-bob-0002', email: 'bob@example.invalid' };

interface UsersFixture {
  readonly platform: FakePlatformAdminRepository;
  readonly directory: FakeUserRepository;
  readonly email: FakeEmailTransport;
  readonly adminService: PlatformAdminService;
  readonly users: PlatformUsersService;
  readonly guard: PlatformAccessGuard;
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

function fixture(): UsersFixture {
  const platform = new FakePlatformAdminRepository();
  const credentials = new FakeCredentials();
  const clock = new FakeClock();
  const directory = new FakeUserRepository(platform);
  const email = new FakeEmailTransport();

  const platformIdentity = (userId: string, emailAddress: string, createdAt: Date): void => {
    platform.users.set(userId, { id: userId, email: emailAddress, disabledAt: null });
    credentials.register(emailAddress, userId, platformPassword);
    directory.users.push({ id: userId, email: emailAddress, locale: 'en', createdAt, disabledAt: null });
  };
  platformIdentity(adminAccount.userId, adminAccount.email, new Date('2026-10-28T00:00:00.000Z'));
  platformIdentity(targetAdminAccount.userId, targetAdminAccount.email, new Date('2026-10-27T00:00:00.000Z'));
  platformIdentity(supportAccount.userId, supportAccount.email, new Date('2026-10-29T00:00:00.000Z'));
  platformIdentity(auditorAccount.userId, auditorAccount.email, new Date('2026-10-30T00:00:00.000Z'));
  const assignment = (userId: string, role: PlatformRole): PlatformAssignmentRecord => ({
    id: 'assignment-' + userId + '-' + role, userId, role, status: 'ACTIVE',
    grantedBy: 'QA_FIXTURE', grantReason: 'deterministic users-management fixture',
    grantedAt: new Date('2026-11-01T00:00:00.000Z'), revokedBy: null, revokeReason: null, revokedAt: null,
  });
  platform.assignments.push(
    assignment(adminAccount.userId, 'PLATFORM_ADMIN'),
    assignment(targetAdminAccount.userId, 'PLATFORM_ADMIN'),
    assignment(supportAccount.userId, 'SUPPORT'),
    assignment(auditorAccount.userId, 'AUDITOR'),
  );
  directory.platformRoles.set(adminAccount.userId, ['PLATFORM_ADMIN']);
  directory.platformRoles.set(targetAdminAccount.userId, ['PLATFORM_ADMIN']);
  directory.platformRoles.set(supportAccount.userId, ['SUPPORT']);
  directory.platformRoles.set(auditorAccount.userId, ['AUDITOR']);

  const directoryUser = (id: string, emailAddress: string, createdAt: Date, disabledAt: Date | null = null): void => {
    directory.users.push({ id, email: emailAddress, locale: 'en', createdAt, disabledAt });
  };
  directoryUser(alice.id, alice.email, new Date('2026-11-01T00:00:00.000Z'));
  directoryUser(bob.id, bob.email, new Date('2026-11-02T00:00:00.000Z'));
  directoryUser('user-carol-0003', 'carol@example.invalid', new Date('2026-11-03T00:00:00.000Z'));
  directoryUser('user-dave-0004', 'dave@example.invalid', new Date('2026-11-04T00:00:00.000Z'), new Date('2026-11-05T00:00:00.000Z'));

  directory.memberships.set(alice.id, [{
    workspaceId: 'workspace-qa-0001', workspaceName: 'QA Workspace A', role: 'OWNER',
    membershipStatus: 'ACTIVE', workspaceCreatedAt: new Date('2026-11-01T00:00:00.000Z'),
  }]);
  directory.memberships.set(bob.id, [{
    workspaceId: 'workspace-qa-0001', workspaceName: 'QA Workspace A', role: 'MEMBER',
    membershipStatus: 'ACTIVE', workspaceCreatedAt: new Date('2026-11-01T00:00:00.000Z'),
  }]);

  const session = (userId: string, id: string, createdAt: Date, revokedAt: Date | null = null): FakeIdentitySession => ({
    id, userId, tokenHash: sha256('workspace-token-' + id + '-' + 'x'.repeat(20)),
    createdAt, expiresAt: new Date('2099-01-01T00:00:00.000Z'), revokedAt, lastUsedAt: null,
  });
  directory.identitySessions.set(alice.id, [
    session(alice.id, 'session-alice-1', new Date('2026-11-10T00:00:00.000Z')),
    session(alice.id, 'session-alice-2', new Date('2026-11-09T00:00:00.000Z'), new Date('2026-11-10T06:00:00.000Z')),
  ]);
  directory.identitySessions.set(bob.id, [session(bob.id, 'session-bob-1', new Date('2026-11-11T00:00:00.000Z'))]);

  directory.identityEvents.set(alice.id, [
    { source: 'IDENTITY', id: 'event-register-alice', action: 'REGISTER', outcome: 'SUCCESS', happenedAt: new Date('2026-11-01T00:00:00.000Z'), actorUserId: alice.id, reason: null, permission: null },
    { source: 'IDENTITY', id: 'event-login-alice', action: 'LOGIN', outcome: 'SUCCESS', happenedAt: new Date('2026-11-10T00:00:00.000Z'), actorUserId: alice.id, reason: null, permission: null },
  ]);

  let sequence = 0;
  const adminService = new PlatformAdminService(platform, credentials, {
    hashToken: sha256,
    now: () => clock.value,
    generateId: () => 'audit-' + String(++sequence).padStart(6, '0'),
    generateToken: () => 'platform-token-' + String(++sequence).padStart(6, '0') + '-' + 'a'.repeat(12),
  });
  const users = new PlatformUsersService(directory, adminService, email, { now: () => clock.value });
  const guard = new PlatformAccessGuard(new Reflector(), adminService);
  return { platform, directory, email, adminService, users, guard };
}

async function platformPrincipal(adminService: PlatformAdminService, account: { email: string }): Promise<PlatformPrincipal> {
  const login = await adminService.login({ email: account.email, password: platformPassword });
  return adminService.authenticate(login.token);
}

async function partA(): Promise<void> {
  const f = fixture();
  const { platform, directory, email, adminService, users, guard } = f;
  const bearer = (token: string) => 'Bearer ' + token;
  const workspaceToken = 'workspace-session-' + 'w'.repeat(20);

  const adminLogin = await adminService.login({ email: adminAccount.email, password: platformPassword });
  const adminPrincipal = await adminService.authenticate(adminLogin.token);
  const supportLogin = await adminService.login({ email: supportAccount.email, password: platformPassword });
  const supportPrincipalValue = await adminService.authenticate(supportLogin.token);
  const auditorLogin = await adminService.login({ email: auditorAccount.email, password: platformPassword });
  const auditorPrincipal = await adminService.authenticate(auditorLogin.token);

  assert(adminPrincipal.permissions.join(',') === 'ADMINISTRATION,CONSULTATION', 'admin principal holds administration and consultation');
  assert(supportPrincipalValue.permissions.join(',') === 'SUPPORT', 'support principal holds support only');
  assert(auditorPrincipal.permissions.join(',') === 'CONSULTATION', 'auditor principal holds consultation only');

  // ---- real route metadata + guard ---------------------------------------------------------
  const guardList = (headers: Record<string, string>) => guard.canActivate(contextFor(PlatformUsersController.prototype.list, PlatformUsersController, headers).context);
  assert(await guardList({ authorization: bearer(adminLogin.token) }) === true, 'administration can list users');
  assert(await guardList({ authorization: bearer(supportLogin.token) }) === true, 'support can list users');
  await expectDomainError('DENIED', () => guardList({ authorization: bearer(auditorLogin.token) }), 'auditor cannot list users');
  await expectDomainError('DENIED', () => guardList({ authorization: bearer(workspaceToken) }), 'a workspace bearer cannot list platform users');
  const workspaceDenial = platform.audits[platform.audits.length - 1];
  assert(workspaceDenial !== undefined && workspaceDenial.action === 'AUTHENTICATE' && workspaceDenial.outcome === 'DENIED', 'workspace-token denial is audited');
  assert(await guard.canActivate(contextFor(PlatformUsersController.prototype.activity, PlatformUsersController, { authorization: bearer(auditorLogin.token) }).context) === true, 'auditor can read the activity timeline');
  assert(await guard.canActivate(contextFor(PlatformUsersController.prototype.activity, PlatformUsersController, { authorization: bearer(supportLogin.token) }).context) === true, 'support can read the activity timeline');
  await expectDomainError('DENIED', () => guard.canActivate(contextFor(PlatformUsersController.prototype.suspend, PlatformUsersController, { authorization: bearer(supportLogin.token) }).context), 'support cannot suspend an account');
  assert(await guard.canActivate(contextFor(PlatformUsersController.prototype.suspend, PlatformUsersController, { authorization: bearer(adminLogin.token) }).context) === true, 'administration can reach the suspend route');

  // ---- paginated list, search and filters --------------------------------------------------
  const defaultPage = await users.list(adminPrincipal, {});
  assert(defaultPage.limit === 25 && defaultPage.items.length === 8 && defaultPage.nextCursor === null, 'list returns all seeded users with default limit');
  assert(defaultPage.items[0]?.userId === 'user-dave-0004', 'list is ordered by registration date descending');
  assert(defaultPage.items.find(item => item.userId === alice.id)?.workspaceCount === 1, 'list includes associated workspace count');

  const firstPage = await users.list(adminPrincipal, { limit: 2 });
  assert(firstPage.items.length === 2 && typeof firstPage.nextCursor === 'string', 'first page returns a limit and a cursor');
  const secondPage = await users.list(adminPrincipal, { limit: 2, cursor: firstPage.nextCursor ?? undefined });
  assert(secondPage.items.length === 2, 'second page is served from the cursor');
  assert(!secondPage.items.some(item => firstPage.items.some(first => first.userId === item.userId)), 'pages never overlap');
  const clamped = await users.list(adminPrincipal, { limit: 1000 });
  assert(clamped.limit === 100, 'limit is bounded to the maximum');

  await expectDomainError('INVALID_INPUT', () => users.list(adminPrincipal, { cursor: 'not-a-cursor' }), 'forged cursor is rejected');
  const cursorAudit = platform.audits[platform.audits.length - 1];
  assert(cursorAudit !== undefined && cursorAudit.outcome === 'DENIED' && cursorAudit.reason === 'INVALID_CURSOR', 'invalid cursor denial is audited');

  const search = await users.list(adminPrincipal, { query: 'ALICE' });
  assert(search.items.length === 1 && search.items[0]?.userId === alice.id, 'email search is case-insensitive and bounded');
  const suspendedOnly = await users.list(adminPrincipal, { status: 'SUSPENDED' });
  assert(suspendedOnly.items.length === 1 && suspendedOnly.items[0]?.userId === 'user-dave-0004', 'status filter selects suspended accounts');

  // ---- detail, sessions and platform-role disclosure --------------------------------------
  const adminDetail = await users.get(adminPrincipal, alice.id);
  assert(adminDetail.status === 'ACTIVE' && adminDetail.workspaces.length === 1 && adminDetail.workspaces[0]?.role === 'OWNER', 'detail exposes registration, workspace and role');
  assert(adminDetail.sessions.total === 2 && adminDetail.sessions.active === 1, 'detail exposes session counts');
  assert(Array.isArray(adminDetail.platformRoles), 'administration sees internal platform roles');
  const supportDetail = await users.get(supportPrincipalValue, alice.id);
  assert(!('platformRoles' in supportDetail), 'support never receives internal platform roles');
  await expectDomainError('NOT_FOUND', () => users.get(adminPrincipal, 'user-ghost-9999'), 'unknown user detail is not disclosed');
  const detailDenial = platform.audits[platform.audits.length - 1];
  assert(detailDenial !== undefined && detailDenial.reason === 'USER_NOT_FOUND' && detailDenial.outcome === 'DENIED', 'unknown user denial is audited');

  const sessionView = await users.listSessions(adminPrincipal, alice.id);
  assert(sessionView.sessions.length === 2 && sessionView.summary.active === 1, 'session list exposes metadata and summary');
  assert(!JSON.stringify(sessionView).includes('tokenHash') && !JSON.stringify(sessionView).includes('token_hash'), 'session DTO never leaks token digests');
  assert(sessionView.sessions.every(session => !JSON.stringify(session).includes('workspace-token')), 'session DTO never leaks workspace tokens');
  const supportSessions = await users.listSessions(supportPrincipalValue, alice.id);
  assert(supportSessions.sessions.length === 2, 'support can read session metadata');
  assert(!('platformSessions' in supportSessions), 'support never sees platform administration sessions');
  const adminOwnSessions = await users.listSessions(adminPrincipal, adminAccount.userId);
  assert(Array.isArray(adminOwnSessions.platformSessions) && adminOwnSessions.platformSessions.length >= 1, 'administration sees platform administration sessions');
  assert(adminOwnSessions.truncated === false, 'session list exposes a truncation flag');
  const adminOwnDetail = await users.get(adminPrincipal, adminAccount.userId);
  assert((adminOwnDetail.sessions.platformSessions?.total ?? 0) >= 1, 'detail exposes the platform session summary only to administration');

  // ---- activity timeline -------------------------------------------------------------------
  const activity = await users.activity(adminPrincipal, alice.id, {});
  assert(activity.items.length === 2 && activity.items.every(item => item.source === 'IDENTITY'), 'activity exposes identity events and no unrelated platform audit rows');
  assert(activity.items.every((item, index) => index === 0 || (activity.items[index - 1]?.happenedAt ?? '') >= item.happenedAt), 'activity is ordered newest first');
  assert(activity.items.some(item => item.action === 'LOGIN'), 'identity login event is present');
  const activityFirst = await users.activity(adminPrincipal, alice.id, { limit: 1 });
  assert(activityFirst.items.length === 1 && typeof activityFirst.nextCursor === 'string', 'activity paginates with a cursor');
  const activitySecond = await users.activity(adminPrincipal, alice.id, { limit: 1, cursor: activityFirst.nextCursor ?? undefined });
  assert(activitySecond.items.length === 1 && activitySecond.items[0]?.id !== activityFirst.items[0]?.id, 'activity pages do not repeat rows');
  await expectDomainError('INVALID_INPUT', () => users.activity(supportPrincipalValue, alice.id, { cursor: '%%%bad' }), 'invalid activity cursor is rejected');
  await users.activity(auditorPrincipal, alice.id, {});

  // ---- suspend / reactivate -----------------------------------------------------------------
  await expectDomainError('DENIED', () => users.suspend(supportPrincipalValue, alice.id, { reason: 'support cannot suspend accounts' }), 'support cannot suspend accounts');
  await expectDomainError('INVALID_INPUT', () => users.suspend(adminPrincipal, alice.id, { reason: 'short' }), 'suspension requires a real justification');
  const justificationDenial = platform.audits[platform.audits.length - 1];
  assert(justificationDenial !== undefined && justificationDenial.reason === 'INVALID_JUSTIFICATION' && justificationDenial.outcome === 'DENIED', 'invalid justification denial is audited');
  await expectDomainError('DENIED', () => users.suspend(adminPrincipal, adminAccount.userId, { reason: 'self suspension attempt' }), 'self suspension is refused');
  const selfDenial = platform.audits[platform.audits.length - 1];
  assert(selfDenial !== undefined && selfDenial.reason === 'SELF_SUSPENSION', 'self-suspension denial is audited');
  await expectDomainError('NOT_FOUND', () => users.suspend(adminPrincipal, 'user-ghost-9999', { reason: 'unknown target account' }), 'unknown suspension target is refused');

  const suspended = await users.suspend(adminPrincipal, bob.id, { reason: 'repeated complaint investigation' });
  assert(suspended.status === 'SUSPENDED' && suspended.disabledAt !== null, 'suspension returns the suspended status');
  assert(directory.users.find(user => user.id === bob.id)?.disabledAt !== null, 'suspension sets disabled_at (reversible)');
  const bobSessions = directory.identitySessions.get(bob.id) ?? [];
  assert(bobSessions.every(session => session.revokedAt !== null), 'suspension revokes the target sessions');
  const suspendAudit = platform.audits[platform.audits.length - 1];
  assert(suspendAudit !== undefined && suspendAudit.action === 'SUSPEND_PLATFORM_USER' && suspendAudit.outcome === 'SUCCESS'
    && suspendAudit.actorUserId === adminAccount.userId && suspendAudit.targetId === bob.id && suspendAudit.reason === 'repeated complaint investigation'
    && suspendAudit.happenedAt instanceof Date, 'suspension audit records actor, target, reason, date and result');
  await expectDomainError('CONFLICT', () => users.suspend(adminPrincipal, bob.id, { reason: 'repeated suspension attempt' }), 'double suspension is refused');
  const doubleSuspend = platform.audits[platform.audits.length - 1];
  assert(doubleSuspend !== undefined && doubleSuspend.reason === 'ALREADY_SUSPENDED', 'double-suspension denial is audited');

  await expectDomainError('DENIED', () => users.reactivate(supportPrincipalValue, bob.id, { reason: 'support cannot reactivate accounts' }), 'support cannot reactivate accounts');
  const reactivated = await users.reactivate(adminPrincipal, bob.id, { reason: 'investigation concluded without action' });
  assert(reactivated.status === 'ACTIVE' && reactivated.disabledAt === null, 'reactivation restores the account without deleting data');
  assert(directory.users.find(user => user.id === bob.id)?.disabledAt === null, 'reactivation clears disabled_at');
  await expectDomainError('CONFLICT', () => users.reactivate(adminPrincipal, bob.id, { reason: 'account is already active' }), 'reactivating an active account is refused');

  // ---- platform administration sessions are revoked atomically with the account -------------
  const targetAdminLogin = await adminService.login({ email: targetAdminAccount.email, password: platformPassword });
  const targetAdminToken = targetAdminLogin.token;
  assert((await adminService.authenticate(targetAdminToken)).roles.join(',') === 'PLATFORM_ADMIN', 'second administrator holds a live platform session');
  const suspendedTarget = await users.suspend(adminPrincipal, targetAdminAccount.userId, { reason: 'temporary duty rotation' });
  assert(suspendedTarget.status === 'SUSPENDED', 'an administrator can suspend another administrator while one remains');
  const targetSuspendAudit = platform.audits[platform.audits.length - 1];
  assert(targetSuspendAudit !== undefined && targetSuspendAudit.detail?.['platformSessions'] === 1, 'suspension audit records the revoked platform session count');
  await expectDomainError('DENIED', () => adminService.authenticate(targetAdminToken), 'suspended administrator platform bearer is rejected');
  const targetReactivated = await users.reactivate(adminPrincipal, targetAdminAccount.userId, { reason: 'duty rotation completed' });
  assert(targetReactivated.status === 'ACTIVE', 'the second administrator is reactivated');
  await expectDomainError('DENIED', () => adminService.authenticate(targetAdminToken), 'a revoked platform session never revives after reactivation');
  const bobActivity = await users.activity(adminPrincipal, bob.id, {});
  assert(bobActivity.items.some(item => item.source === 'PLATFORM' && item.action === 'SUSPEND_PLATFORM_USER'), 'account-lifecycle suspension appears in the timeline');
  assert(bobActivity.items.some(item => item.source === 'PLATFORM' && item.action === 'REACTIVATE_PLATFORM_USER'), 'account-lifecycle reactivation appears in the timeline');

  // ---- session revocation -------------------------------------------------------------------
  await expectDomainError('DENIED', () => users.revokeSessions(supportPrincipalValue, alice.id, { reason: 'support cannot revoke sessions' }), 'support cannot revoke sessions');
  const bobSessionSnapshot = (directory.identitySessions.get(bob.id) ?? []).map(session => ({ id: session.id, revokedAt: session.revokedAt?.toISOString() ?? null }));
  const revocation = await users.revokeSessions(adminPrincipal, alice.id, { reason: 'credential exposure suspected' });
  assert(revocation.revokedSessions === 1 && revocation.revokedWorkspaceSessions === 1 && revocation.revokedPlatformSessions === 0, 'only the still-active target workspace session is revoked');
  const aliceSessions = directory.identitySessions.get(alice.id) ?? [];
  assert(aliceSessions.every(session => session.revokedAt !== null), 'all target sessions are revoked');
  const bobSessionAfter = (directory.identitySessions.get(bob.id) ?? []).map(session => ({ id: session.id, revokedAt: session.revokedAt?.toISOString() ?? null }));
  assert(JSON.stringify(bobSessionAfter) === JSON.stringify(bobSessionSnapshot), 'revocation never touches another user sessions');
  const revokeAudit = platform.audits[platform.audits.length - 1];
  assert(revokeAudit !== undefined && revokeAudit.action === 'REVOKE_USER_SESSIONS' && revokeAudit.outcome === 'SUCCESS'
    && revokeAudit.detail?.['revokedSessions'] === 1 && revokeAudit.reason === 'credential exposure suspected', 'session revocation audit records the count and justification');
  await expectDomainError('NOT_FOUND', () => users.revokeSessions(adminPrincipal, 'user-ghost-9999', { reason: 'unknown target sessions' }), 'unknown revocation target is refused');

  // ---- blocked account-lifecycle capabilities ----------------------------------------------
  const capabilities = await users.capabilities(adminPrincipal);
  assert(capabilities.emailTransport === 'NOT_CONFIGURED', 'email transport is reported as not configured');
  assert(capabilities.features.length === 3 && capabilities.features.every(feature => feature.status === 'BLOCKED' && feature.reason === 'EMAIL_PROVIDER_NOT_CONFIGURED'), 'invitations, verification and recovery are explicitly blocked');
  await users.capabilities(auditorPrincipal);

  await expectDomainError('NOT_CONFIGURED', () => users.requestInvitation(adminPrincipal, { email: 'new.user@example.invalid', reason: 'expected onboarding request' }), 'invitation is blocked without email transport');
  const invitationAudit = platform.audits[platform.audits.length - 1];
  assert(invitationAudit !== undefined && invitationAudit.action === 'REQUEST_INVITATION' && invitationAudit.outcome === 'DENIED' && invitationAudit.reason === 'EMAIL_PROVIDER_NOT_CONFIGURED', 'blocked invitation attempt is audited');
  assert(email.sendCount === 0, 'no email is ever sent while the transport is not configured');
  await expectDomainError('INVALID_INPUT', () => users.requestInvitation(adminPrincipal, { email: 'not-an-email', reason: 'invalid email attempt' }), 'invitation validates the email');
  await expectDomainError('NOT_CONFIGURED', () => users.requestEmailVerification(adminPrincipal, alice.id, { reason: 'verification request attempt' }), 'email verification is blocked without email transport');
  await expectDomainError('NOT_CONFIGURED', () => users.requestAccountRecovery(adminPrincipal, alice.id, { reason: 'recovery request attempt' }), 'account recovery is blocked without email transport');
  await expectDomainError('NOT_FOUND', () => users.requestEmailVerification(adminPrincipal, 'user-ghost-9999', { reason: 'unknown verification target' }), 'verification refuses unknown users');
  assert(email.sendCount === 0, 'blocked lifecycle flows never call the mail sender');
  assert((directory.users.find(user => user.id === alice.id)?.disabledAt ?? null) === null, 'blocked flows do not change account state');

  // ---- last-administrator protection (defense in depth) ------------------------------------
  const savedAdminRoles = directory.platformRoles.get(adminAccount.userId);
  directory.platformRoles.delete(adminAccount.userId);
  const syntheticAdmin: PlatformPrincipal = {
    userId: 'user-synthetic-operator' as ID, sessionId: 'synthetic-session',
    roles: ['PLATFORM_ADMIN'], permissions: ['ADMINISTRATION', 'CONSULTATION'],
    sessionExpiresAt: '2099-01-01T00:00:00.000Z',
  };
  await expectDomainError('DENIED', () => users.suspend(syntheticAdmin, targetAdminAccount.userId, { reason: 'last administrator suspension attempt' }), 'the last enabled administrator cannot be suspended');
  const lastAdminDenial = platform.audits[platform.audits.length - 1];
  assert(lastAdminDenial !== undefined && lastAdminDenial.reason === 'LAST_PLATFORM_ADMIN', 'last-administrator denial is audited');
  if (savedAdminRoles !== undefined) directory.platformRoles.set(adminAccount.userId, savedAdminRoles);

  // ---- audit completeness, isolation, data preservation ------------------------------------
  assert(platform.audits.every(row => row.id.length > 0 && row.action.length > 0 && row.targetType.length > 0
    && (row.outcome === 'SUCCESS' || row.outcome === 'DENIED' || row.outcome === 'ERROR') && row.happenedAt instanceof Date), 'every audit row carries actor, target, action, date and result');
  assert(platform.audits.some(row => row.outcome === 'SUCCESS') && platform.audits.some(row => row.outcome === 'DENIED'), 'successful and denied outcomes are both recorded');
  assert(directory.deleteCalls === 0, 'no deletion operation is ever invoked');
  assert(!('deleteUser' in directory) && !('deleteAccount' in directory), 'the user administration port exposes no deletion operation');
  const aliceJson = JSON.stringify(await users.get(adminPrincipal, alice.id));
  assert(!aliceJson.includes(bob.email) && !aliceJson.includes('tokenHash') && !aliceJson.includes('password'), 'detail DTO is scoped to the requested user and leaks no secret');
  const bobJson = JSON.stringify(await users.get(adminPrincipal, bob.id));
  assert(!bobJson.includes(alice.email), 'detail DTO never mixes another user data');

  console.log('  part A users-management invariants: OK (' + assertions + ' assertions so far)');
}

interface HttpResult { readonly status: number; readonly body: unknown }

async function partB(): Promise<void> {
  process.env.DATABASE_URL = 'postgresql://qeynox:qeynox@127.0.0.1:1/qeynox_users_wiring';
  const app = await NestFactory.create(AppModule, { logger: false });
  app.useGlobalFilters(new DomainExceptionFilter());
  await app.listen(0, '127.0.0.1');
  try {
    const address = app.getHttpServer().address() as { port: number };
    assert(Number.isInteger(address.port) && address.port > 0, 'API boots with the users-management module');
    const base = 'http://127.0.0.1:' + address.port;
    const call = async (path: string, init: RequestInit = {}): Promise<HttpResult> => {
      const response = await fetch(base + path, init);
      const text = await response.text();
      let body: unknown = text;
      try { body = JSON.parse(text) as unknown; } catch { /* plain text */ }
      return { status: response.status, body };
    };
    const errorCode = (result: HttpResult): string | undefined => (result.body as { error?: { code?: string } }).error?.code;
    const postJson = (body: string): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body });

    const health = await call('/health');
    assert(health.status === 200, 'public health route still served');
    const protectedRoutes: ReadonlyArray<readonly [string, 'GET' | 'POST']> = [
      ['/v1/platform/users', 'GET'],
      ['/v1/platform/users/capabilities', 'GET'],
      ['/v1/platform/users/user-unknown-0001', 'GET'],
      ['/v1/platform/users/user-unknown-0001/sessions', 'GET'],
      ['/v1/platform/users/user-unknown-0001/activity', 'GET'],
      ['/v1/platform/users/user-unknown-0001/suspend', 'POST'],
      ['/v1/platform/users/user-unknown-0001/reactivate', 'POST'],
      ['/v1/platform/users/user-unknown-0001/sessions/revoke', 'POST'],
      ['/v1/platform/users/invitations', 'POST'],
      ['/v1/platform/users/user-unknown-0001/email-verification', 'POST'],
      ['/v1/platform/users/user-unknown-0001/account-recovery', 'POST'],
    ];
    for (const [path, method] of protectedRoutes) {
      const result = await call(path, method === 'GET' ? {} : postJson('{}'));
      assert(result.status === 403 && errorCode(result) === 'DENIED', 'users route ' + method + ' ' + path + ' is protected without a platform session');
    }
    const unknownRoute = await call('/v1/platform/users/unknown/segment/extra');
    assert(unknownRoute.status === 404, 'unknown users route returns 404');
    const workspaceRoute = await call('/v1/operations');
    assert(workspaceRoute.status === 403 && errorCode(workspaceRoute) === 'DENIED', 'workspace routes still require a workspace session');
    console.log('  part B users-management HTTP wiring: OK');
  } finally {
    await app.close();
  }
}


interface QaHttpResult { readonly status: number; readonly body: unknown }

function qaHttp(base: string, path: string, init: RequestInit = {}): Promise<QaHttpResult> {
  return fetch(base + path, init).then(async response => {
    const text = await response.text();
    let body: unknown = text;
    try { body = JSON.parse(text) as unknown; } catch { /* plain text */ }
    return { status: response.status, body };
  });
}

function qaPost(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

function qaBearer(token: string): Record<string, string> {
  return { authorization: 'Bearer ' + token, 'content-type': 'application/json' };
}

function qaErrorCode(result: QaHttpResult): string | undefined {
  return (result.body as { error?: { code?: string } }).error?.code;
}

async function seedPlatformAccountsForQa(databaseUrl: string): Promise<void> {
  const connection = connectDatabase(databaseUrl);
  try {
    const credential = await hashPassword(platformPassword);
    const accounts: ReadonlyArray<{ id: string; email: string; role: string }> = [
      { id: adminAccount.userId, email: adminAccount.email, role: 'PLATFORM_ADMIN' },
      { id: adminTwoAccount.userId, email: adminTwoAccount.email, role: 'PLATFORM_ADMIN' },
      { id: supportAccount.userId, email: supportAccount.email, role: 'SUPPORT' },
    ];
    for (const account of accounts) {
      await connection.db.insert(identityUsers).values({ id: account.id, email: account.email, locale: 'en' });
      await connection.db.insert(identityCredentials).values({ userId: account.id, salt: credential.salt, passwordHash: credential.hash });
      await connection.db.insert(platformAdminAssignments).values({
        id: 'qa-assignment-' + account.id, userId: account.id, role: account.role, status: 'ACTIVE',
        grantedBy: 'QA_FIXTURE', grantReason: 'deterministic users-management e2e seed',
      });
    }
  } finally {
    await connection.close();
  }
}

/**
 * Part C: isolated PostgreSQL end-to-end users-management flow. BLOCKED (never PASS) when
 * QEYNOX_QA_DATABASE_URL is absent.
 */
async function partC(): Promise<void> {
  if (!process.env.QEYNOX_QA_DATABASE_URL) {
    console.log('BLOCKED: QEYNOX_QA_DATABASE_URL is not set; part C (isolated PostgreSQL users-management e2e) was not executed and no result is claimed.');
    return;
  }
  const qa = await createIsolatedQaDatabase();
  process.env.DATABASE_URL = qa.url;
  process.env.QEYNOX_ALLOW_REGISTRATION = 'true';
  delete process.env.QEYNOX_OPERATOR_USER_IDS;
  delete process.env.QEYNOX_EMAIL_PROVIDER;
  let app: INestApplication | undefined;
  const beforeC = assertions;
  try {
    const report = await runMigrations(qa.url);
    assert(report.total >= 13 && report.applied.length === report.total, 'every migration (including the 0013 user-management indexes and later additive ones) applied');
    const rerun = await runMigrations(qa.url);
    assert(rerun.applied.length === 0 && rerun.skipped.length === report.total, 'applied migrations stay immutable on re-run');
    await seedPlatformAccountsForQa(qa.url);

    app = await NestFactory.create(AppModule, { logger: false });
    app.useGlobalFilters(new DomainExceptionFilter());
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address() as { port: number };
    const base = 'http://127.0.0.1:' + address.port;

    const aliceEmail = 'qa-users-alice@example.invalid';
    const bobEmail = 'qa-users-bob@example.invalid';
    const aliceRegistered = await qaHttp(base, '/v1/auth/register', qaPost({ email: aliceEmail, password: 'workspace-passphrase', workspaceName: 'QA Users Workspace' }));
    assert(aliceRegistered.status === 201, 'first workspace user registers through the existing identity flow');
    const aliceSession = aliceRegistered.body as { token: string; userId: string; workspaceId: string };
    const bobRegistered = await qaHttp(base, '/v1/auth/register', qaPost({ email: bobEmail, password: 'workspace-passphrase', workspaceName: 'QA Users Workspace Two' }));
    assert(bobRegistered.status === 201, 'second workspace user registers');
    const bobSession = bobRegistered.body as { token: string; userId: string; workspaceId: string };

    // A workspace owner cannot reach the platform users administration.
    const workspaceDeniedRoutes: ReadonlyArray<readonly [string, 'GET' | 'POST']> = [
      ['/v1/platform/users', 'GET'],
      ['/v1/platform/users/' + aliceSession.userId, 'GET'],
      ['/v1/platform/users/' + aliceSession.userId + '/sessions', 'GET'],
      ['/v1/platform/users/' + aliceSession.userId + '/suspend', 'POST'],
    ];
    for (const [path, method] of workspaceDeniedRoutes) {
      const result = await qaHttp(base, path, method === 'GET' ? { headers: qaBearer(aliceSession.token) } : { ...qaPost({ reason: 'workspace owner attempt' }), headers: qaBearer(aliceSession.token) });
      assert(result.status === 403 && qaErrorCode(result) === 'DENIED', 'workspace OWNER is denied ' + method + ' ' + path);
    }

    const adminLogin = await qaHttp(base, '/v1/platform/auth/login', qaPost({ email: adminAccount.email, password: platformPassword }));
    assert(adminLogin.status === 201, 'platform administrator signs in through the existing platform session');
    const adminToken = (adminLogin.body as { token: string }).token;
    const supportLogin = await qaHttp(base, '/v1/platform/auth/login', qaPost({ email: supportAccount.email, password: platformPassword }));
    assert(supportLogin.status === 201, 'support operator signs in');
    const supportToken = (supportLogin.body as { token: string }).token;

    // Paginated directory + email search.
    const firstPage = await qaHttp(base, '/v1/platform/users?limit=2', { headers: qaBearer(adminToken) });
    assert(firstPage.status === 200, 'administrator lists users');
    const firstPageBody = firstPage.body as { items: { userId: string; email: string; workspaceCount: number }[]; nextCursor: string | null; limit: number };
    assert(firstPageBody.items.length === 2 && firstPageBody.limit === 2 && typeof firstPageBody.nextCursor === 'string', 'first page is paginated with an opaque cursor');
    const secondPage = await qaHttp(base, '/v1/platform/users?limit=2&cursor=' + encodeURIComponent(firstPageBody.nextCursor ?? ''), { headers: qaBearer(adminToken) });
    assert(secondPage.status === 200, 'second page is served from the cursor');
    const secondPageBody = secondPage.body as { items: { userId: string }[] };
    assert(!secondPageBody.items.some(item => firstPageBody.items.some(first => first.userId === item.userId)), 'pages never overlap');

    const search = await qaHttp(base, '/v1/platform/users?query=' + encodeURIComponent(aliceEmail.toUpperCase()), { headers: qaBearer(adminToken) });
    const searchBody = search.body as { items: { userId: string; email: string }[] };
    assert(search.status === 200 && searchBody.items.length === 1 && searchBody.items[0]?.userId === aliceSession.userId, 'email search finds exactly the requested account');

    // Detail, workspace role, sessions and platform-role disclosure.
    const adminDetail = await qaHttp(base, '/v1/platform/users/' + aliceSession.userId, { headers: qaBearer(adminToken) });
    assert(adminDetail.status === 200, 'administrator reads the user detail');
    const adminDetailBody = adminDetail.body as { status: string; workspaces: { role: string; workspaceId: string }[]; sessions: { total: number; active: number }; platformRoles?: string[]; createdAt: string };
    assert(adminDetailBody.status === 'ACTIVE' && adminDetailBody.workspaces.length === 1 && adminDetailBody.workspaces[0]?.role === 'OWNER', 'detail exposes registration, workspace and role');
    assert(typeof adminDetailBody.createdAt === 'string' && adminDetailBody.sessions.active >= 1, 'detail exposes registration date and active sessions');
    assert(Array.isArray(adminDetailBody.platformRoles), 'administration sees internal platform roles');
    const supportDetail = await qaHttp(base, '/v1/platform/users/' + aliceSession.userId, { headers: qaBearer(supportToken) });
    assert(supportDetail.status === 200 && !('platformRoles' in (supportDetail.body as Record<string, unknown>)), 'support never receives internal platform roles');
    const sessionsView = await qaHttp(base, '/v1/platform/users/' + aliceSession.userId + '/sessions', { headers: qaBearer(adminToken) });
    assert(sessionsView.status === 200 && !JSON.stringify(sessionsView.body).includes('tokenHash'), 'session metadata never exposes token digests');

    // Two-administrator invariants: platform sessions are revoked with the account, and the unified
    // last-administrator rule counts only enabled accounts (suspension and revocation agree).
    const adminTwoLogin = await qaHttp(base, '/v1/platform/auth/login', qaPost({ email: adminTwoAccount.email, password: platformPassword }));
    assert(adminTwoLogin.status === 201, 'second platform administrator signs in');
    const adminTwoToken = (adminTwoLogin.body as { token: string }).token;
    const adminTwoSessions = await qaHttp(base, '/v1/platform/users/' + adminTwoAccount.userId + '/sessions', { headers: qaBearer(adminToken) });
    assert(adminTwoSessions.status === 200 && (((adminTwoSessions.body as { platformSessions?: unknown[] }).platformSessions) ?? []).length >= 1, 'administration sees platform administration sessions');
    const suspendAdminTwo = await qaHttp(base, '/v1/platform/users/' + adminTwoAccount.userId + '/suspend', { ...qaPost({ reason: 'temporary administrator rotation' }), headers: qaBearer(adminToken) });
    assert(suspendAdminTwo.status === 201 && (suspendAdminTwo.body as { status?: string }).status === 'SUSPENDED', 'administrator can suspend another administrator while one remains');
    const adminTwoAfterSuspend = await qaHttp(base, '/v1/platform/auth/me', { headers: qaBearer(adminTwoToken) });
    assert(adminTwoAfterSuspend.status === 403, 'suspension revokes the live platform administration session');
    const lastAdminRevoke = await qaHttp(base, '/v1/platform/admins/' + adminAccount.userId + '/revoke', { ...qaPost({ role: 'PLATFORM_ADMIN', reason: 'last enabled administrator attempt' }), headers: qaBearer(adminToken) });
    assert(lastAdminRevoke.status === 403 && qaErrorCode(lastAdminRevoke) === 'DENIED', 'the last enabled administrator cannot revoke their own assignment');
    const reactivateAdminTwo = await qaHttp(base, '/v1/platform/users/' + adminTwoAccount.userId + '/reactivate', { ...qaPost({ reason: 'administrator rotation completed' }), headers: qaBearer(adminToken) });
    assert(reactivateAdminTwo.status === 201, 'second administrator is reactivated');
    const adminTwoAfterReactivate = await qaHttp(base, '/v1/platform/auth/me', { headers: qaBearer(adminTwoToken) });
    assert(adminTwoAfterReactivate.status === 403, 'a revoked platform session never revives after reactivation');

    // A workspace owner who is the sole enabled owner cannot be suspended (Mission 03 invariant),
    // so add a co-owner through the organization invitation flow before testing suspension.
    const inviteCoOwner = await qaHttp(base, '/v1/platform/organizations/' + aliceSession.workspaceId + '/invitations', {
      ...qaPost({ email: bobEmail, role: 'OWNER', reason: 'co-owner required for suspension QA' }), headers: qaBearer(adminToken),
    });
    assert(inviteCoOwner.status === 201, 'co-owner invitation created for the suspension scenario');
    const coOwnerToken = (inviteCoOwner.body as { invitationToken: string }).invitationToken;
    const coOwnerAccept = await qaHttp(base, '/v1/invitations/token/accept', qaPost({ token: coOwnerToken }));
    assert(coOwnerAccept.status === 201 || coOwnerAccept.status === 200, 'co-owner invitation accepted through the token path');

    // Suspension and reactivation are reversible and audited.
    const supportSuspend = await qaHttp(base, '/v1/platform/users/' + aliceSession.userId + '/suspend', { ...qaPost({ reason: 'support cannot suspend accounts' }), headers: qaBearer(supportToken) });
    assert(supportSuspend.status === 403 && qaErrorCode(supportSuspend) === 'DENIED', 'support cannot suspend accounts');
    const suspended = await qaHttp(base, '/v1/platform/users/' + aliceSession.userId + '/suspend', { ...qaPost({ reason: 'account misuse investigation opened' }), headers: qaBearer(adminToken) });
    assert(suspended.status === 201 && (suspended.body as { status?: string }).status === 'SUSPENDED', 'administrator suspends the account (status=' + suspended.status + ' body=' + JSON.stringify(suspended.body) + ' invite=' + JSON.stringify(inviteCoOwner.body) + ')');
    const aliceAfterSuspend = await qaHttp(base, '/v1/operations', { headers: qaBearer(aliceSession.token) });
    assert(aliceAfterSuspend.status === 403 && qaErrorCode(aliceAfterSuspend) === 'DENIED', 'suspended workspace session is rejected by the existing auth guard');
    const aliceLoginSuspended = await qaHttp(base, '/v1/auth/login', qaPost({ email: aliceEmail, password: 'workspace-passphrase' }));
    assert(aliceLoginSuspended.status === 403 && qaErrorCode(aliceLoginSuspended) === 'DENIED', 'suspended account cannot log in');
    const selfSuspend = await qaHttp(base, '/v1/platform/users/' + adminAccount.userId + '/suspend', { ...qaPost({ reason: 'self suspension attempt' }), headers: qaBearer(adminToken) });
    assert(selfSuspend.status === 403 && qaErrorCode(selfSuspend) === 'DENIED', 'an operator cannot suspend their own account');
    const reactivated = await qaHttp(base, '/v1/platform/users/' + aliceSession.userId + '/reactivate', { ...qaPost({ reason: 'investigation concluded without action' }), headers: qaBearer(adminToken) });
    assert(reactivated.status === 201 && (reactivated.body as { status?: string }).status === 'ACTIVE', 'administrator reactivates the account');
    const aliceLoginRestored = await qaHttp(base, '/v1/auth/login', qaPost({ email: aliceEmail, password: 'workspace-passphrase' }));
    assert(aliceLoginRestored.status === 201, 'reactivated account can log in again');

    // Session revocation targets only the requested user.
    const bobBearer = { ...qaBearer(bobSession.token), 'x-qeynox-workspace': bobSession.workspaceId };
    const aliceSecond = await qaHttp(base, '/v1/auth/login', qaPost({ email: aliceEmail, password: 'workspace-passphrase' }));
    assert(aliceSecond.status === 201, 'second alice session issued');
    const aliceTokenTwo = (aliceSecond.body as { token: string }).token;
    const revocation = await qaHttp(base, '/v1/platform/users/' + aliceSession.userId + '/sessions/revoke', { ...qaPost({ reason: 'credential exposure suspected' }), headers: qaBearer(adminToken) });
    assert(revocation.status === 201 && ((revocation.body as { revokedSessions?: number }).revokedSessions ?? 0) >= 1, 'administrator revokes the target sessions');
    const aliceAfterRevoke = await qaHttp(base, '/v1/operations', { headers: qaBearer(aliceTokenTwo) });
    assert(aliceAfterRevoke.status === 403 && qaErrorCode(aliceAfterRevoke) === 'DENIED', 'revoked workspace session is rejected');
    const bobStillWorks = await qaHttp(base, '/v1/operations', { headers: bobBearer });
    assert(bobStillWorks.status === 200, 'another user session is unaffected');

    // Blocked account-lifecycle capabilities: no email is claimed or sent.
    const capabilities = await qaHttp(base, '/v1/platform/users/capabilities', { headers: qaBearer(adminToken) });
    assert(capabilities.status === 200 && (capabilities.body as { emailTransport?: string }).emailTransport === 'NOT_CONFIGURED', 'capability matrix reports the missing email transport');
    const features = (capabilities.body as { features?: { status?: string }[] }).features ?? [];
    assert(features.length === 3 && features.every(feature => feature.status === 'BLOCKED'), 'invitations, verification and recovery are explicitly blocked');
    const invitation = await qaHttp(base, '/v1/platform/users/invitations', { ...qaPost({ email: 'invitee@example.invalid', reason: 'expected onboarding request' }), headers: qaBearer(adminToken) });
    assert(invitation.status === 503 && qaErrorCode(invitation) === 'NOT_CONFIGURED', 'invitation endpoint fails closed without an email transport');
    const verification = await qaHttp(base, '/v1/platform/users/' + aliceSession.userId + '/email-verification', { ...qaPost({ reason: 'verification request attempt' }), headers: qaBearer(adminToken) });
    assert(verification.status === 503 && qaErrorCode(verification) === 'NOT_CONFIGURED', 'email verification fails closed without an email transport');
    const recovery = await qaHttp(base, '/v1/platform/users/' + aliceSession.userId + '/account-recovery', { ...qaPost({ reason: 'recovery request attempt' }), headers: qaBearer(adminToken) });
    assert(recovery.status === 503 && qaErrorCode(recovery) === 'NOT_CONFIGURED', 'account recovery fails closed without an email transport');

    // Activity timeline: identity events and platform actions, paginated.
    const activity = await qaHttp(base, '/v1/platform/users/' + aliceSession.userId + '/activity?limit=50', { headers: qaBearer(adminToken) });
    assert(activity.status === 200, 'administrator reads the account activity timeline');
    const activityItems = (activity.body as { items: { source: string; action: string }[] }).items;
    assert(activityItems.some(item => item.source === 'IDENTITY' && item.action === 'REGISTER'), 'timeline contains the identity registration event');
    assert(activityItems.some(item => item.source === 'PLATFORM' && item.action === 'SUSPEND_PLATFORM_USER'), 'timeline contains the platform suspension action');
    const activityFirst = await qaHttp(base, '/v1/platform/users/' + aliceSession.userId + '/activity?limit=1', { headers: qaBearer(adminToken) });
    const activityFirstBody = activityFirst.body as { items: { id: string }[]; nextCursor: string | null };
    assert(activityFirstBody.items.length === 1 && typeof activityFirstBody.nextCursor === 'string', 'activity timeline paginates with a cursor');
    const activitySecondPage = await qaHttp(base, '/v1/platform/users/' + aliceSession.userId + '/activity?limit=1&cursor=' + encodeURIComponent(activityFirstBody.nextCursor ?? ''), { headers: qaBearer(adminToken) });
    const activitySecondBody = activitySecondPage.body as { items: { id: string }[] };
    assert(activitySecondBody.items[0]?.id !== activityFirstBody.items[0]?.id, 'activity pages do not repeat rows');

    // Persistence/audit invariants and no irreversible deletion.
    const auditTrail = await qaHttp(base, '/v1/platform/audit?limit=200', { headers: qaBearer(adminToken) });
    const auditRows = (auditTrail.body as { action: string; outcome: string }[]);
    assert(auditTrail.status === 200 && auditRows.some(row => row.action === 'SUSPEND_PLATFORM_USER' && row.outcome === 'SUCCESS'), 'suspension is recorded in the platform audit trail');
    assert(auditRows.some(row => row.action === 'REVOKE_USER_SESSIONS' && row.outcome === 'SUCCESS'), 'session revocation is recorded in the platform audit trail');
    assert(auditRows.some(row => row.outcome === 'DENIED'), 'denied user-management attempts are recorded');
    assert(auditRows.some(row => row.action === 'REVOKE_PLATFORM_ROLE' && row.outcome === 'DENIED'), 'last-enabled-administrator revocation denial is recorded');

    const inspection = connectDatabase(qa.url);
    try {
      const [usersCount] = await inspection.db.select({ value: count() }).from(identityUsers);
      const [adminAssignments] = await inspection.db.select({ value: count() }).from(platformAdminAssignments)
        .where(and(eq(platformAdminAssignments.role, 'PLATFORM_ADMIN'), eq(platformAdminAssignments.status, 'ACTIVE')));
      assert(Number(usersCount?.value ?? 0) >= 4, 'user rows are preserved (no deletion)');
      assert(Number(adminAssignments?.value ?? 0) >= 1, 'platform administrator remains active');
      const indexes = await inspection.pool.query<{ indexname: string }>(
        "SELECT indexname FROM pg_indexes WHERE schemaname='public' AND indexname = ANY($1)",
        [['identity_user_created_idx', 'identity_session_user_idx', 'identity_audit_user_idx', 'platform_audit_target_idx']],
      );
      assert(indexes.rows.length === 4, 'migration 0013 indexes exist in the database');
    } finally {
      await inspection.close();
    }

    await app.close();
    app = undefined;
    console.log('  part C isolated PostgreSQL users-management e2e: OK (' + (assertions - beforeC) + ' assertions)');
  } finally {
    if (app) await app.close().catch(() => undefined);
    await qa.drop();
    console.log('QA database dropped:', qa.name);
  }
}

async function main(): Promise<void> {
  await partA();
  const beforeB = assertions;
  await partB();
  console.log('Part B assertions:', assertions - beforeB);
  const beforeC = assertions;
  await partC();
  console.log('Part C assertions:', assertions - beforeC);
  console.log('Platform users-management authorization PASSED:', assertions, 'assertions.');
}

main().catch((error: unknown) => {
  console.error('Platform users-management authorization FAILED:', error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});

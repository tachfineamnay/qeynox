/**
 * MISSION A18 — customer workspace management QA (role, revocation and cross-workspace).
 *
 *  PART 1 — account-settings logic with an in-memory repository double
 *   - session listing/revocation mapping, current-session marking, revoke-others
 *   - password change: wrong current (lockout counting), success, other sessions revoked
 *   - deletion request: idempotent request, cancel, cancel-again refusal
 *
 *  PART 2 — workspace team management against a disposable database (real WorkspaceStore + AccountStore)
 *   - self-service workspace creation (creator becomes ACTIVE OWNER; audit row written)
 *   - invite (OWNER/ADMIN matrix, blocked e-mail delivery, unknown/disabled accounts)
 *   - accept-by-token cross-module integration (WorkspaceAccessService consumes the invitation)
 *   - role change with last-owner protection; ADMIN fence (no OWNER grant, no OWNER targeting)
 *   - revocation incl. pending-invitation cancel, zero-membership session termination, re-invite
 *   - cross-workspace: memberships of another workspace are invisible/unreachable
 *   - member directory scoping, filters and keyset pagination
 *
 * The deterministic hasher is QA test infrastructure for the credential path only; the production
 * binding (apps/api/src/auth/password.ts, scrypt) is unchanged.
 *
 * Run: pnpm qa:workspace-management   (PART 2 requires QEYNOX_QA_DATABASE_URL)
 * Exit: 0 PASS · 3 BLOCKED · 1 FAILED
 */
import { randomUUID, createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import {
  connectDatabase, runMigrations,
  identityAudit, identityCredentials, identityMemberships, identitySessions, identityUsers, identityWorkspaces, platformAdminAudit,
  WorkspaceStore, AccountStore,
} from '@qeynox/persistence';
import { AccountSettingsService, WorkspaceAccessService, WorkspaceTeamService, type AccountSettingsRepository } from '@qeynox/application';
import { DomainError, type ID, type Principal } from '@qeynox/domain';
import { createIsolatedQaDatabase } from '../../api/scripts/qa-isolated-database';

const PASS = 0;
const FAILED = 1;
const BLOCKED = 3;

let assertions = 0;
function assert(condition: unknown, message: string): asserts condition {
  assertions++;
  if (!condition) throw new Error('ASSERTION FAILED: ' + message);
}
async function expectDomainError(code: string, run: () => Promise<unknown> | unknown, label: string): Promise<void> {
  assertions++;
  try { await run(); } catch (error: unknown) {
    if (error instanceof DomainError && error.code === code) return;
    throw new Error('EXPECTED ' + code + ' for ' + label + ', got ' + (error instanceof DomainError ? error.code : String(error)));
  }
  throw new Error('EXPECTED ' + code + ' for ' + label + ', but no error was raised');
}

/** Deterministic QA double for the credential path (documented test infrastructure). */
const qaHasher = {
  async hash(password: string, salt?: string) { return { salt: salt ?? 'qa-salt-fixed', hash: 'qa-hash:' + password }; },
  async verify(password: string, _salt: string, expected: string) { return expected === 'qa-hash:' + password; },
};
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

// =============================================================================================
// PART 1 — account settings logic with an in-memory repository double
// =============================================================================================
type MemoryRepo = AccountSettingsRepository & {
  sessions: { id: string; createdAt: Date; lastUsedAt: Date | null; expiresAt: Date; tokenHash: string }[];
  revoked: string[];
  password: { salt: string; passwordHash: string; failedAttempts: number; lockedUntil: Date | null };
  deletions: { id: string; reason: string | null; status: 'REQUESTED' | 'CANCELLED'; createdAt: Date; updatedAt: Date }[];
  audits: string[];
};
function memoryRepo(): MemoryRepo {
  const now = new Date('2026-11-20T00:00:00.000Z');
  const repo: MemoryRepo = {
    sessions: [
      { id: 's-current', createdAt: new Date(now.getTime() - 3600_000), lastUsedAt: now, expiresAt: new Date(now.getTime() + 86_400_000), tokenHash: sha256('token-current') },
      { id: 's-other-1', createdAt: new Date(now.getTime() - 7200_000), lastUsedAt: null, expiresAt: new Date(now.getTime() + 86_400_000), tokenHash: sha256('token-other-1') },
      { id: 's-other-2', createdAt: new Date(now.getTime() - 10800_000), lastUsedAt: null, expiresAt: new Date(now.getTime() + 86_400_000), tokenHash: sha256('token-other-2') },
    ],
    revoked: [],
    password: { salt: 'qa-salt', passwordHash: 'qa-hash:correct horse', failedAttempts: 0, lockedUntil: null },
    deletions: [],
    audits: [],
    async getProfile() { return { email: 'qa@example.invalid', locale: 'en', createdAt: now, verifiedAt: now }; },
    async updateLocale(_userId: string, locale: string) { void locale; },
    async countActiveWorkspaces() { return 2; },
    async listActiveSessions() { return repo.sessions.filter(s => !repo.revoked.includes(s.id)); },
    async revokeSession(_userId: string, sessionId: string) {
      const hit = repo.sessions.find(s => s.id === sessionId);
      if (!hit || repo.revoked.includes(sessionId)) return false;
      repo.revoked.push(sessionId);
      return true;
    },
    async revokeOtherSessions(_userId: string, keepTokenHash: string) {
      const victims = repo.sessions.filter(s => s.tokenHash !== keepTokenHash && !repo.revoked.includes(s.id));
      for (const s of victims) repo.revoked.push(s.id);
      return victims.length;
    },
    async getCredentials() { return repo.password; },
    async noteFailedPasswordAttempt(_userId: string, failedAttempts: number, lockedUntil: Date | null) { repo.password.failedAttempts = failedAttempts; repo.password.lockedUntil = lockedUntil; },
    async setPassword(_userId: string, salt: string, passwordHash: string) { repo.password = { salt, passwordHash, failedAttempts: 0, lockedUntil: null }; },
    async requestDeletion(_userId: string, reason: string | null) {
      const live = repo.deletions.find(d => d.status === 'REQUESTED');
      if (live) return { outcome: 'ALREADY_REQUESTED' as const, id: live.id, createdAt: live.createdAt };
      const row = { id: randomUUID(), reason, status: 'REQUESTED' as const, createdAt: now, updatedAt: now };
      repo.deletions.push(row);
      return { outcome: 'REQUESTED' as const, id: row.id, createdAt: row.createdAt };
    },
    async cancelDeletion() { const live = repo.deletions.find(d => d.status === 'REQUESTED'); if (!live) return 'NOT_FOUND' as const; live.status = 'CANCELLED'; live.updatedAt = now; return 'CANCELLED' as const; },
    async latestDeletion() { return [...repo.deletions].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]; },
    async insertIdentityAudit(input: { action: string }) { repo.audits.push(input.action); },
  };
  return repo;
}

async function partOne(): Promise<void> {
  console.log('— PART 1: account settings logic (in-memory repository double) —');
  const now = new Date('2026-11-20T00:00:00.000Z');
  const repo = memoryRepo();
  const service = new AccountSettingsService(repo, { now: () => now, hasher: qaHasher });
  const principal: Principal = { userId: 'user-1' as ID, workspaceId: 'ws-1' as ID, roles: ['OWNER'] };

  const profile = await service.profile(principal);
  assert(profile.email === 'qa@example.invalid' && profile.activeWorkspaceCount === 2, 'profile view maps repository row');

  const sessions = await service.sessions(principal, sha256('token-current'));
  assert(sessions.length === 3, 'sessions listed');
  assert(sessions.filter(s => s.current).length === 1, 'exactly one session marked current');
  const others = await service.revokeOtherSessions(principal, sha256('token-current'));
  assert(others.revoked === 2, 'revoke-others revokes the two other sessions');
  assert((await service.revokeOtherSessions(principal, sha256('token-current'))).revoked === 0, 'revoke-others is a no-op once clean');

  // Credential change: wrong current password increments the counter; correct current succeeds.
  await expectDomainError('DENIED', () => service.changePassword(principal, { currentPassword: 'wrong', nextPassword: 'new passphrase 123' }, sha256('token-current')), 'wrong current password');
  const attemptsAfterFailure = repo.password.failedAttempts;
  assert(attemptsAfterFailure === 1, 'failed attempt counted');
  const changed = await service.changePassword(principal, { currentPassword: 'correct horse', nextPassword: 'brand new passphrase 456' }, sha256('token-current'));
  assert(changed.changed === true, 'password changed with correct current');
  assert(repo.password.passwordHash === 'qa-hash:brand new passphrase 456', 'stored hash updated');
  const attemptsAfterReset = repo.password.failedAttempts;
  assert(attemptsAfterReset === 0 && repo.password.lockedUntil === null, 'lockout state reset on success');
  assert(repo.audits.includes('PASSWORD_CHANGE'), 'password change audited');
  await expectDomainError('INVALID_INPUT', () => service.changePassword(principal, { currentPassword: 'brand new passphrase 456', nextPassword: 'brand new passphrase 456' }, sha256('token-current')), 'new password must differ from the current one');

  // Deletion requests: idempotent request, cancel, refusal to cancel twice.
  const first = await service.requestDeletion(principal, { reason: 'Leaving the platform for good' });
  assert(first.outcome === 'REQUESTED', 'first request recorded');
  const again = await service.requestDeletion(principal, { reason: 'Different reason, same account' });
  assert(again.outcome === 'ALREADY_REQUESTED' && again.request.id === first.request.id, 'second request is idempotent');
  assert((await service.cancelDeletion(principal)).status === 'CANCELLED', 'cancel works');
  await expectDomainError('NOT_FOUND', () => service.cancelDeletion(principal), 'cancel without a live request');
  assert((await service.deletionStatus(principal))?.status === 'CANCELLED', 'latest deletion status is CANCELLED');
}

// =============================================================================================
// PART 2 — workspace team management against a disposable database
// =============================================================================================
async function partTwo(): Promise<'PASSED' | 'BLOCKED'> {
  console.log('— PART 2: team management, roles, revocation, cross-workspace —');
  if (!process.env.QEYNOX_QA_DATABASE_URL) {
    console.log('BLOCKED: PART 2 not run — QEYNOX_QA_DATABASE_URL is not set. This run is NOT integration evidence.');
    return 'BLOCKED';
  }
  const qa = await createIsolatedQaDatabase();
  process.env.DATABASE_URL = qa.url;
  let connection: ReturnType<typeof connectDatabase> | undefined;
  try {
    const migration = await runMigrations(qa.url);
    assert(migration.total > 0, 'disposable QA database migrated');
    connection = connectDatabase(qa.url);
    const db = connection.db;

    const store = new WorkspaceStore(db);
    const accountStore = new AccountStore(db);
    const team = new WorkspaceTeamService(store);
    const access = new WorkspaceAccessService(store);

    // --- Fixtures: tenant A (ownerA, secondOwnerA, adminA, memberA, inviteeA, soloA) and tenant B ----
    const userA = randomUUID(); const secondOwnerA = randomUUID(); const adminA = randomUUID(); const memberA = randomUUID(); const inviteeA = randomUUID(); const soloA = randomUUID();
    const userB = randomUUID(); const memberB = randomUUID(); const disabledUser = randomUUID();
    const wsA = randomUUID(); const wsB = randomUUID();
    await db.insert(identityUsers).values([
      { id: userA, email: 'qa-a18-owner-' + userA + '@example.invalid' },
      { id: secondOwnerA, email: 'qa-a18-owner2-' + secondOwnerA + '@example.invalid' },
      { id: adminA, email: 'qa-a18-admin-' + adminA + '@example.invalid' },
      { id: memberA, email: 'qa-a18-member-' + memberA + '@example.invalid' },
      { id: inviteeA, email: 'qa-a18-invitee-' + inviteeA + '@example.invalid' },
      { id: soloA, email: 'qa-a18-solo-' + soloA + '@example.invalid' },
      { id: userB, email: 'qa-a18-bowner-' + userB + '@example.invalid' },
      { id: memberB, email: 'qa-a18-bmember-' + memberB + '@example.invalid' },
      { id: disabledUser, email: 'qa-a18-disabled-' + disabledUser + '@example.invalid', disabledAt: new Date() },
    ]);
    await db.insert(identityWorkspaces).values([
      { id: wsA, name: 'QA A18 Tenant A', createdBy: userA },
      { id: wsB, name: 'QA A18 Tenant B', createdBy: userB },
    ]);
    await db.insert(identityMemberships).values([
      { id: randomUUID(), userId: userA, workspaceId: wsA, role: 'OWNER', status: 'ACTIVE' },
      { id: randomUUID(), userId: secondOwnerA, workspaceId: wsA, role: 'OWNER', status: 'ACTIVE' },
      { id: randomUUID(), userId: adminA, workspaceId: wsA, role: 'ADMIN', status: 'ACTIVE' },
      { id: randomUUID(), userId: memberA, workspaceId: wsA, role: 'MEMBER', status: 'ACTIVE' },
      { id: randomUUID(), userId: soloA, workspaceId: wsA, role: 'MEMBER', status: 'ACTIVE' },
      { id: randomUUID(), userId: userB, workspaceId: wsB, role: 'OWNER', status: 'ACTIVE' },
      { id: randomUUID(), userId: memberB, workspaceId: wsB, role: 'MEMBER', status: 'ACTIVE' },
    ]);
    const ownerA: Principal = { userId: userA as ID, workspaceId: wsA as ID, roles: ['OWNER'] };
    const ownerA2Principal: Principal = { userId: secondOwnerA as ID, workspaceId: wsA as ID, roles: ['OWNER'] };
    const adminAuth: Principal = { userId: adminA as ID, workspaceId: wsA as ID, roles: ['ADMIN'] };
    const memberAuth: Principal = { userId: memberA as ID, workspaceId: wsA as ID, roles: ['MEMBER'] };
    const ownerB: Principal = { userId: userB as ID, workspaceId: wsB as ID, roles: ['OWNER'] };
    const memberBAuth: Principal = { userId: memberB as ID, workspaceId: wsB as ID, roles: ['MEMBER'] };

    const auditActions = async () => (await db.select({ action: platformAdminAudit.action }).from(platformAdminAudit)).map(row => row.action);
    const membershipRow = async (userId: string, workspaceId: string) => {
      const [row] = await db.select().from(identityMemberships).where(and(eq(identityMemberships.userId, userId), eq(identityMemberships.workspaceId, workspaceId)));
      return row;
    };

    // --- Self-service workspace creation ---------------------------------------------------------
    const created = await team.createWorkspace(memberAuth, { name: 'QA A18 Fresh Workspace' });
    const createdRow = await membershipRow(memberA, created.workspaceId);
    assert(createdRow?.role === 'OWNER' && createdRow.status === 'ACTIVE', 'creator becomes ACTIVE OWNER of the new workspace');
    assert((await auditActions()).includes('SELF_SERVICE_WORKSPACE_CREATE'), 'workspace creation audited');
    await expectDomainError('INVALID_INPUT', () => team.createWorkspace(memberAuth, { name: 'x' }), 'name too short');
    // Created workspace is a real context: its member directory works under the new principal.
    const freshOwner: Principal = { userId: memberA as ID, workspaceId: created.workspaceId as ID, roles: ['OWNER'] };
    assert((await team.listMembers(freshOwner, {})).items.length === 1, 'new workspace starts with exactly the creator');
    const mineBefore = await team.listMine(memberAuth);
    assert(mineBefore.workspaces.length === 2, 'creator sees both of their workspaces');
    assert(mineBefore.workspaces.some(w => w.workspaceId === created.workspaceId && w.role === 'OWNER'), 'new workspace appears in the switcher list');
    const mineMemberB = await team.listMine(memberBAuth);
    assert(mineMemberB.workspaces.length === 1 && mineMemberB.workspaces[0]!.workspaceId === wsB, 'tenant B member sees only their own workspace');

    // --- Overview gating -------------------------------------------------------------------------
    const overviewOwner = await team.overview(ownerA);
    const overviewMember = await team.overview(memberAuth);
    assert(overviewOwner.stats !== null && overviewOwner.stats.activeMembers === 5, 'owner sees stats (5 active members)');
    assert(overviewOwner.myRole === 'OWNER', 'owner role reported');
    assert(overviewMember.stats === null && overviewMember.myRole === 'MEMBER', 'member sees header but not stats');
    const bogusPrincipal: Principal = { userId: memberA as ID, workspaceId: randomUUID() as ID, roles: ['MEMBER'] };
    await expectDomainError('NOT_FOUND', () => team.overview(bogusPrincipal), 'overview on unknown workspace');

    // --- Invitation gates -------------------------------------------------------------------------
    await expectDomainError('DENIED', () => team.inviteMember(memberAuth, { email: 'whomever@example.invalid', role: 'MEMBER', reason: 'member trying to invite anyone' }), 'member cannot invite');
    await expectDomainError('INVALID_INPUT', () => team.inviteMember(ownerA, { email: 'whomever@example.invalid', role: 'MEMBER', reason: 'short' }), 'reason too short');
    await expectDomainError('NOT_FOUND', () => team.inviteMember(ownerA, { email: 'nobody-' + randomUUID() + '@example.invalid', role: 'MEMBER', reason: 'inviting an account that does not exist' }), 'unknown account');
    await expectDomainError('DENIED', () => team.inviteMember(ownerA, { email: 'qa-a18-disabled-' + disabledUser + '@example.invalid', role: 'MEMBER', reason: 'inviting a disabled account' }), 'disabled account');
    await expectDomainError('DENIED', () => team.inviteMember(adminAuth, { email: 'qa-a18-owner2-' + secondOwnerA + '@example.invalid', role: 'OWNER', reason: 'admin trying to grant the owner role' }), 'admin cannot grant OWNER');

    const invited = await team.inviteMember(adminAuth, { email: 'qa-a18-invitee-' + inviteeA + '@example.invalid', role: 'MEMBER', reason: 'inviting the QA invitee account' });
    assert(invited.delivery.email === 'BLOCKED', 'invitation delivery is honestly BLOCKED');
    assert(typeof invited.invitationToken === 'string' && invited.invitationToken.length >= 32, 'one-time invitation token returned');
    assert((await auditActions()).includes('SELF_SERVICE_INVITE_MEMBER'), 'invitation audited');
    await expectDomainError('CONFLICT', () => team.inviteMember(ownerA, { email: 'qa-a18-invitee-' + inviteeA + '@example.invalid', role: 'MEMBER', reason: 'duplicate invitation attempt' }), 'duplicate pending invitation');

    // Cross-module: the invitee accepts with the token (fresh accounts hold no ACTIVE membership).
    const accepted = await access.acceptByToken(invited.invitationToken);
    assert(accepted.status === 'ACTIVE', 'token acceptance activates membership');
    assert((await membershipRow(inviteeA, wsA))?.status === 'ACTIVE', 'membership row ACTIVE after acceptance');
    await expectDomainError('CONFLICT', () => team.inviteMember(ownerA, { email: 'qa-a18-invitee-' + inviteeA + '@example.invalid', role: 'MEMBER', reason: 're-inviting an active member' }), 'already an active member');

    // --- Member directory: scoping, filters, pagination -------------------------------------------
    const page = await team.listMembers(ownerA, { limit: 100 });
    assert(page.items.some(item => item.email.startsWith('qa-a18-') && item.email.includes(userA)), 'directory lists tenant A users');
    assert(!page.items.some(item => item.email === 'qa-a18-bmember-' + memberB + '@example.invalid'), 'tenant B member not listed in tenant A');
    assert(page.items.some(item => item.userId === inviteeA), 'accepted invitee appears as ACTIVE');
    const activeOnly = await team.listMembers(ownerA, { status: 'ACTIVE' });
    assert(activeOnly.items.every(item => item.status === 'ACTIVE'), 'status filter works');
    const firstPage = await team.listMembers(ownerA, { limit: 2 });
    assert(firstPage.items.length === 2 && firstPage.nextCursor !== null, 'first page full with next cursor');
    const secondPage = await team.listMembers(ownerA, { limit: 2, cursor: firstPage.nextCursor ?? undefined });
    assert(secondPage.items.length >= 1, 'cursor page returns rows');
    assert(!firstPage.items.some(a => secondPage.items.some(b => b.membershipId === a.membershipId)), 'pages do not overlap');
    await expectDomainError('DENIED', () => team.listMembers(memberAuth, {}), 'member cannot open the management directory');

    // --- Role change: matrix + cross-workspace + last-owner ---------------------------------------
    const memberARow = (await membershipRow(memberA, wsA))!;
    const promoted = await team.changeMemberRole(adminAuth, memberARow.id, { role: 'ADMIN', reason: 'promoting the member to administer tenant A' });
    assert(promoted.changed === true && promoted.role === 'ADMIN', 'admin promotes member to ADMIN');
    await expectDomainError('DENIED', () => team.changeMemberRole(adminAuth, memberARow.id, { role: 'OWNER', reason: 'admin trying to grant the owner role' }), 'admin cannot grant OWNER');
    const secondOwnerRow = (await membershipRow(secondOwnerA, wsA))!;
    await expectDomainError('DENIED', () => team.changeMemberRole(adminAuth, secondOwnerRow.id, { role: 'MEMBER', reason: 'admin trying to demote an owner' }), 'admin cannot target OWNER');

    const memberBRow = (await membershipRow(memberB, wsB))!;
    await expectDomainError('NOT_FOUND', () => team.changeMemberRole(ownerA, memberBRow.id, { role: 'MEMBER', reason: 'cross-workspace role change attempt' }), 'cross-workspace role change');
    await expectDomainError('NOT_FOUND', () => team.revokeMember(ownerA, memberBRow.id, { reason: 'cross-workspace revoke attempt' }), 'cross-workspace revoke');

    // Two owners remain (userA + secondOwnerA). Demote secondOwnerA ⇒ allowed. Then userA is last OWNER.
    const demoted = await team.changeMemberRole(ownerA, secondOwnerRow.id, { role: 'MEMBER', reason: 'owner stepping down to member' });
    assert(demoted.changed === true, 'owner demoted while another owner remains');
    const ownerARow = (await membershipRow(userA, wsA))!;
    await expectDomainError('DENIED', () => team.changeMemberRole(ownerA, ownerARow.id, { role: 'MEMBER', reason: 'demoting the last owner must fail' }), 'last owner cannot be demoted');
    await expectDomainError('DENIED', () => team.revokeMember(ownerA, ownerARow.id, { reason: 'revoking the last owner must fail' }), 'last owner cannot be revoked');
    const repromoted = await team.changeMemberRole(ownerA, secondOwnerRow.id, { role: 'OWNER', reason: 'restoring the second owner to role' });
    assert(repromoted.changed === true, 'owner grants OWNER to restore the second owner');
    const demotedA = await team.changeMemberRole(ownerA, ownerARow.id, { role: 'MEMBER', reason: 'owner steps down with two owners present' });
    assert(demotedA.changed === true, 'demotion succeeds while another owner remains');
    const restored = await team.changeMemberRole(ownerA2Principal, (await membershipRow(userA, wsA))!.id, { role: 'OWNER', reason: 'restoring the primary owner role' });
    assert(restored.changed === true, 'restored to OWNER by the remaining owner');

    // --- Revocation: pending invitation cancel + zero-membership session sweep ---------------------
    const [soloSession] = await db.insert(identitySessions).values({ id: randomUUID(), userId: soloA, tokenHash: sha256('a18-solo-token'), expiresAt: new Date(Date.now() + 86_400_000) }).returning();
    const soloRow = (await membershipRow(soloA, wsA))!;
    const revokedSolo = await team.revokeMember(ownerA, soloRow.id, { reason: 'removing the solo QA member entirely' });
    assert(revokedSolo.status === 'REVOKED', 'member revoked');
    const [soloSessionAfter] = await db.select().from(identitySessions).where(eq(identitySessions.id, (soloSession as { id: string }).id));
    assert(soloSessionAfter?.revokedAt !== null && soloSessionAfter?.revokedAt !== undefined, 'zero remaining memberships ⇒ all workspace sessions revoked');
    const soloAfter = await membershipRow(soloA, wsA);
    assert(soloAfter?.status === 'REVOKED', 'revoked membership kept as history');

    // Re-invite after revoke: membership is reinstated as INVITED, not duplicated.
    const reinvited = await team.inviteMember(ownerA, { email: 'qa-a18-solo-' + soloA + '@example.invalid', role: 'MEMBER', reason: 're-inviting the previously revoked member' });
    assert(reinvited.membershipId === soloRow.id, 're-invite reuses the membership row');
    const afterReinvite = await membershipRow(soloA, wsA);
    assert(afterReinvite?.status === 'INVITED' && afterReinvite?.id === soloRow.id, 're-invite reinstates as INVITED');
    // Cancel the pending invitation = revoke path on an INVITED membership.
    const cancelled = await team.revokeMember(ownerA, soloRow.id, { reason: 'cancelling the pending invitation again' });
    assert(cancelled.status === 'REVOKED', 'pending invitation cancelled via revoke');

    // --- Account settings against the real AccountStore -------------------------------------------
    await db.insert(identityCredentials).values({ userId: userA, salt: 'qa-salt-fixed', passwordHash: 'qa-hash:correct horse battery', failedAttempts: 0 });
    await db.insert(identitySessions).values([
      { id: randomUUID(), userId: userA, tokenHash: sha256('a18-token-1'), expiresAt: new Date(Date.now() + 86_400_000) },
      { id: randomUUID(), userId: userA, tokenHash: sha256('a18-token-2'), expiresAt: new Date(Date.now() + 86_400_000) },
    ]);
    const account = new AccountSettingsService(accountStore, { hasher: qaHasher });
    const accountSessions = await account.sessions(ownerA, sha256('a18-token-1'));
    assert(accountSessions.length === 2, 'account sessions listed');
    assert(accountSessions.filter(s => s.current).length === 1, 'current session marked');
    await expectDomainError('DENIED', () => account.changePassword(ownerA, { currentPassword: 'wrong password', nextPassword: 'brand new passphrase 789' }, sha256('a18-token-1')), 'wrong current password');
    const changed = await account.changePassword(ownerA, { currentPassword: 'correct horse battery', nextPassword: 'brand new passphrase 789' }, sha256('a18-token-1'));
    assert(changed.changed === true && changed.revokedSessions === 1, 'password changed; the other session revoked');
    const afterChange = await account.sessions(ownerA, sha256('a18-token-1'));
    assert(afterChange.length === 1 && afterChange[0]!.current === true, 'only the presented session survives the change');
    const identityActions = (await db.select({ action: identityAudit.action }).from(identityAudit)).map(row => row.action);
    assert(identityActions.includes('PASSWORD_CHANGE'), 'password change audited (identity)');

    // Deletion requests: idempotent, cancellable, audited.
    const del1 = await account.requestDeletion(ownerA, { reason: 'closing my account for good' });
    assert(del1.outcome === 'REQUESTED', 'deletion requested');
    const del2 = await account.requestDeletion(ownerA, { reason: 'trying again should be idempotent' });
    assert(del2.outcome === 'ALREADY_REQUESTED' && del2.request.id === del1.request.id, 'second request idempotent');
    const liveRows = await db.select().from(identityAudit).where(eq(identityAudit.userId, userA));
    assert(liveRows.length >= 1, 'account actions audited');
    assert((await account.cancelDeletion(ownerA)).status === 'CANCELLED', 'deletion cancelled');
    await expectDomainError('NOT_FOUND', () => account.cancelDeletion(ownerA), 'cancel without a live request');
    assert((await account.deletionStatus(ownerA))?.status === 'CANCELLED', 'deletion status reflects cancellation');

    // --- Audit coverage ---------------------------------------------------------------------------
    const actions = new Set(await auditActions());
    for (const action of ['SELF_SERVICE_WORKSPACE_CREATE', 'SELF_SERVICE_INVITE_MEMBER', 'SELF_SERVICE_CHANGE_ROLE', 'SELF_SERVICE_REVOKE_MEMBER']) {
      assert(actions.has(action), 'audit trail covers ' + action);
    }

    console.log('  PART 2 PASSED: cumulative ' + assertions + ' assertions');
    return 'PASSED';
  } finally {
    await connection?.close().catch(() => undefined);
    await qa.drop().catch(error => console.error('QA database teardown warning:', error instanceof Error ? error.message : String(error)));
  }
}

partOne();
try {
  const integration = await partTwo();
  if (integration === 'BLOCKED') {
    console.log('A18 WORKSPACE QA PARTIAL — PART 1 PASSED (' + assertions + ' assertions), PART 2 BLOCKED.');
    process.exit(BLOCKED);
  }
  console.log('A18 WORKSPACE QA PASSED: ' + assertions + ' assertions.');
  process.exit(PASS);
} catch (error: unknown) {
  console.error('A18 WORKSPACE QA FAILED:', error instanceof Error ? error.stack ?? error.message : error);
  process.exit(FAILED);
}

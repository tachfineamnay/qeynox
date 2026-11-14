/**
 * Workspace/organisation administration QA on an isolated PostgreSQL database.
 *
 * Requires QEYNOX_QA_DATABASE_URL (qeynox_qa_* databases are created and dropped by the harness).
 * Covers two distinct organisations, forbidden cross-tenant access, invitations over existing
 * identity accounts (no e-mail transport), role changes, last-owner protection, explicit workspace
 * switching and session invalidation.
 *
 * BLOCKED (never PASS) when QEYNOX_QA_DATABASE_URL is absent.
 */
import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { and, count, eq } from 'drizzle-orm';
import {
  connectDatabase, identityCredentials, identityMemberships, identityUsers,
  identityWorkspaces, platformAdminAssignments, runMigrations,
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
  const requestInit: RequestInit = init.body !== undefined
    ? { ...init, headers: { 'content-type': 'application/json', ...(init.headers as Record<string, string> | undefined) } }
    : init;
  const response = await fetch(base + path, requestInit);
  const text = await response.text();
  let body: unknown = text;
  try { body = JSON.parse(text) as unknown; } catch { /* plain text */ }
  return { status: response.status, body };
}
function postJson(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}
function auth(token: string, workspaceId: string): Record<string, string> {
  return { authorization: 'Bearer ' + token, 'x-qeynox-workspace': workspaceId, 'content-type': 'application/json' };
}
function authPost(token: string, workspaceId: string, body: unknown): RequestInit {
  return { method: 'POST', headers: auth(token, workspaceId), body: JSON.stringify(body) };
}
function errorCode(result: HttpResult): string | undefined {
  return (result.body as { error?: { code?: string } }).error?.code;
}
function items<T>(result: HttpResult): T[] {
  if (Array.isArray(result.body)) return result.body as T[];
  return ((result.body as { items?: T[] }).items) ?? [];
}

const platformPassword = 'organization-qa-passphrase';
const adminAccount = { userId: 'org-qa-admin', email: 'org-admin@example.invalid' };
const supportAccount = { userId: 'org-qa-support', email: 'org-support@example.invalid' };
const auditorAccount = { userId: 'org-qa-auditor', email: 'org-auditor@example.invalid' };

async function seedPlatformAccounts(databaseUrl: string): Promise<void> {
  const connection = connectDatabase(databaseUrl);
  try {
    const credential = await hashPassword(platformPassword);
    const accounts: ReadonlyArray<{ id: string; email: string; role: string }> = [
      { id: adminAccount.userId, email: adminAccount.email, role: 'PLATFORM_ADMIN' },
      { id: supportAccount.userId, email: supportAccount.email, role: 'SUPPORT' },
      { id: auditorAccount.userId, email: auditorAccount.email, role: 'AUDITOR' },
    ];
    for (const account of accounts) {
      await connection.db.insert(identityUsers).values({ id: account.id, email: account.email, locale: 'en' });
      await connection.db.insert(identityCredentials).values({ userId: account.id, salt: credential.salt, passwordHash: credential.hash });
      await connection.db.insert(platformAdminAssignments).values({
        id: 'org-qa-assignment-' + account.id, userId: account.id, role: account.role, status: 'ACTIVE',
        grantedBy: 'QA_FIXTURE', grantReason: 'deterministic organization e2e seed',
      });
    }
  } finally {
    await connection.close();
  }
}

async function platformLogin(base: string, email: string): Promise<string> {
  const result = await call(base, '/v1/platform/auth/login', postJson({ email, password: platformPassword }));
  assert(result.status === 201, 'platform login succeeds for ' + email);
  return (result.body as { token: string }).token;
}

interface RegisteredUser { token: string; userId: string; workspaceId: string; workspaces: { workspaceId: string; name: string; role: string }[] }

async function registerUser(base: string, email: string, workspaceName: string): Promise<RegisteredUser> {
  const result = await call(base, '/v1/auth/register', postJson({ email, password: 'workspace-passphrase', workspaceName }));
  assert(result.status === 201, 'workspace registration succeeds for ' + email);
  return result.body as RegisteredUser;
}

async function main(): Promise<void> {
  if (!process.env.QEYNOX_QA_DATABASE_URL) {
    console.log('BLOCKED: QEYNOX_QA_DATABASE_URL is not set. The organizations QA suite requires an isolated PostgreSQL database; no result is claimed.');
    return;
  }
  const qa = await createIsolatedQaDatabase();
  process.env.DATABASE_URL = qa.url;
  process.env.QEYNOX_ALLOW_REGISTRATION = 'true';
  delete process.env.QEYNOX_OPERATOR_USER_IDS;
  let app: INestApplication | undefined;
  try {
    const report = await runMigrations(qa.url);
    assert(report.total >= 14 && report.applied.length === report.total, 'all migrations (including 0014 workspace lifecycle) applied');
    await seedPlatformAccounts(qa.url);

    app = await NestFactory.create(AppModule, { logger: false });
    app.useGlobalFilters(new DomainExceptionFilter());
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address() as { port: number };
    const base = 'http://127.0.0.1:' + address.port;

    // ---- two distinct organisations ---------------------------------------------------------
    const alice = await registerUser(base, 'org-qa-alice@example.invalid', 'QA Org A');
    const bob = await registerUser(base, 'org-qa-bob@example.invalid', 'QA Org B');
    const carol = await registerUser(base, 'org-qa-carol@example.invalid', 'QA Org C');
    const dave = await registerUser(base, 'org-qa-dave@example.invalid', 'QA Org D');
    assert(alice.workspaces.length === 1 && alice.workspaces[0]?.role === 'OWNER', 'registration returns the workspace context and OWNER role');
    assert(alice.workspaceId !== bob.workspaceId, 'two distinct organisations exist');
    const aliceHeaders = auth(alice.token, alice.workspaceId);
    const bobHeaders = auth(bob.token, bob.workspaceId);
    const carolHeaders = auth(carol.token, carol.workspaceId);
    const daveHeaders = auth(dave.token, dave.workspaceId);

    const workspacesView = await call(base, '/v1/auth/workspaces', { headers: aliceHeaders });
    assert(workspacesView.status === 200 && ((workspacesView.body as { workspaces?: unknown[] }).workspaces ?? []).length === 1, 'authenticated identity lists its workspace contexts');

    const adminToken = await platformLogin(base, adminAccount.email);
    const supportToken = await platformLogin(base, supportAccount.email);
    const auditorToken = await platformLogin(base, auditorAccount.email);

    // ---- platform organisation consultation -------------------------------------------------
    const orgList = await call(base, '/v1/platform/organizations?limit=2', { headers: { authorization: 'Bearer ' + adminToken } });
    assert(orgList.status === 200, 'platform administrator lists organisations');
    const firstPage = orgList.body as { items: { workspaceId: string; name: string; owners: number; invited: number }[]; nextCursor: string | null };
    assert((firstPage.items ?? []).length === 2 && typeof firstPage.nextCursor === 'string', 'organisation list is paginated');
    const secondOrgPage = await call(base, '/v1/platform/organizations?limit=2&cursor=' + encodeURIComponent(firstPage.nextCursor ?? ''), { headers: { authorization: 'Bearer ' + adminToken } });
    const secondItems = ((secondOrgPage.body as { items?: { workspaceId: string }[] }).items) ?? [];
    assert(!secondItems.some(item => firstPage.items.some(first => first.workspaceId === item.workspaceId)), 'organisation pages never overlap');
    const searched = await call(base, '/v1/platform/organizations?query=' + encodeURIComponent('QA Org A'), { headers: { authorization: 'Bearer ' + adminToken } });
    const searchItems = items<{ workspaceId: string; name: string }>(searched);
    assert(searched.status === 200 && searchItems.length === 1 && searchItems[0]?.workspaceId === alice.workspaceId, 'organisation search matches by name');

    const orgDetail = await call(base, '/v1/platform/organizations/' + alice.workspaceId, { headers: { authorization: 'Bearer ' + adminToken } });
    const detail = orgDetail.body as { owners?: number; activeMembers?: number; creatorEmail?: string; stats?: { owners?: number } };
    assert(orgDetail.status === 200 && detail.owners === 1 && detail.activeMembers === 1 && detail.creatorEmail === 'org-qa-alice@example.invalid', 'organisation detail exposes owner/member counts and creator');

    // A workspace bearer can never reach platform organisation administration.
    for (const [path, method] of [
      ['/v1/platform/organizations', 'GET'],
      ['/v1/platform/organizations/' + alice.workspaceId, 'GET'],
      ['/v1/platform/organizations/' + alice.workspaceId + '/members', 'GET'],
      ['/v1/platform/organizations/' + alice.workspaceId + '/invitations', 'POST'],
    ] as const) {
      const result = await call(base, path, method === 'GET' ? { headers: aliceHeaders } : authPost(alice.token, alice.workspaceId, { email: 'x@example.invalid', role: 'MEMBER', reason: 'workspace owner attempt' }));
      assert(result.status === 403 && errorCode(result) === 'DENIED', 'workspace bearer is denied ' + method + ' ' + path);
    }
    const supportList = await call(base, '/v1/platform/organizations', { headers: { authorization: 'Bearer ' + supportToken } });
    assert(supportList.status === 200, 'support can consult organisations');
    const auditorList = await call(base, '/v1/platform/organizations', { headers: { authorization: 'Bearer ' + auditorToken } });
    assert(auditorList.status === 403 && errorCode(auditorList) === 'DENIED', 'auditor role cannot consult organisations');

    // ---- cross-tenant data isolation ---------------------------------------------------------
    const bobOperation = await call(base, '/v1/operations', { ...postJson({ title: 'Org B secret operation', goal: 'Cross tenant isolation probe', constraints: [] }), headers: bobHeaders });
    assert(bobOperation.status === 201, 'organisation B creates an operation');
    const bobOperationId = (bobOperation.body as { id: string }).id;
    const aliceReadsBobOperation = await call(base, '/v1/operations/' + bobOperationId, { headers: aliceHeaders });
    assert(aliceReadsBobOperation.status === 404 && errorCode(aliceReadsBobOperation) === 'NOT_FOUND', 'cross-organisation operation access is not disclosed');
    const aliceForwardsBobWorkspace = await call(base, '/v1/operations', { headers: { authorization: 'Bearer ' + alice.token, 'x-qeynox-workspace': bob.workspaceId } });
    assert(aliceForwardsBobWorkspace.status === 403 && errorCode(aliceForwardsBobWorkspace) === 'DENIED', 'a workspace header never grants foreign membership');

    // ---- invitations (existing identity accounts only, no e-mail) ----------------------------
    const membersA = await call(base, '/v1/platform/organizations/' + alice.workspaceId + '/members', { headers: { authorization: 'Bearer ' + adminToken } });
    assert(membersA.status === 200 && items<{ email: string }>(membersA).length === 1, 'organisation member list starts with the owner');

    const inviteCarol = await call(base, '/v1/platform/organizations/' + alice.workspaceId + '/invitations', {
      ...postJson({ email: 'org-qa-carol@example.invalid', role: 'MEMBER', reason: 'cross-organisation collaboration request' }),
      headers: { authorization: 'Bearer ' + adminToken },
    });
    assert(inviteCarol.status === 201, 'platform administrator invites an existing identity account (status=' + inviteCarol.status + ' body=' + JSON.stringify(inviteCarol.body) + ')');
    const carolInvitation = inviteCarol.body as { membershipId: string; status: string; delivery?: { email?: string; reason?: string } };
    assert(carolInvitation.status === 'INVITED' && carolInvitation.delivery?.email === 'BLOCKED', 'invitation delivery is explicitly blocked (no e-mail transport)');
    const duplicateInvite = await call(base, '/v1/platform/organizations/' + alice.workspaceId + '/invitations', {
      ...postJson({ email: 'org-qa-carol@example.invalid', role: 'MEMBER', reason: 'duplicate invitation attempt' }),
      headers: { authorization: 'Bearer ' + adminToken },
    });
    assert(duplicateInvite.status === 409 && errorCode(duplicateInvite) === 'CONFLICT', 'duplicate invitation is refused');
    const inviteMember = await call(base, '/v1/platform/organizations/' + alice.workspaceId + '/invitations', {
      ...postJson({ email: 'org-qa-alice@example.invalid', role: 'MEMBER', reason: 'already a member attempt' }),
      headers: { authorization: 'Bearer ' + adminToken },
    });
    assert(inviteMember.status === 409, 'inviting an existing member is refused');
    const inviteUnknown = await call(base, '/v1/platform/organizations/' + alice.workspaceId + '/invitations', {
      ...postJson({ email: 'unknown-person@example.invalid', role: 'MEMBER', reason: 'unknown identity attempt' }),
      headers: { authorization: 'Bearer ' + adminToken },
    });
    assert(inviteUnknown.status === 404 && errorCode(inviteUnknown) === 'NOT_FOUND', 'invitations require an existing identity account (no e-mail onboarding)');
    const inviteInvalidRole = await call(base, '/v1/platform/organizations/' + alice.workspaceId + '/invitations', {
      ...postJson({ email: 'org-qa-dave@example.invalid', role: 'SUPERADMIN', reason: 'invalid role attempt' }),
      headers: { authorization: 'Bearer ' + adminToken },
    });
    assert(inviteInvalidRole.status === 400, 'unknown workspace roles are refused');

    const carolInvites = await call(base, '/v1/invitations', { headers: carolHeaders });
    assert(carolInvites.status === 200 && items<{ workspaceId: string }>(carolInvites).length === 1 && items<{ workspaceId: string }>(carolInvites)[0]?.workspaceId === alice.workspaceId, 'invitee sees their own pending invitation');
    const aliceTriesCarolInvitation = await call(base, '/v1/invitations/' + carolInvitation.membershipId + '/accept', { method: 'POST', headers: aliceHeaders });
    assert(aliceTriesCarolInvitation.status === 404, 'another user cannot accept an invitation they do not own');
    const bobTriesCarolInvitation = await call(base, '/v1/invitations/' + carolInvitation.membershipId + '/accept', { method: 'POST', headers: bobHeaders });
    assert(bobTriesCarolInvitation.status === 404, 'cross-organisation invitation acceptance is refused');

    const carolAccept = await call(base, '/v1/invitations/' + carolInvitation.membershipId + '/accept', { method: 'POST', headers: carolHeaders });
    assert(carolAccept.status === 201 || carolAccept.status === 200, 'invitee accepts the invitation');
    const carolWorkspaces = await call(base, '/v1/auth/workspaces', { headers: carolHeaders });
    assert(((carolWorkspaces.body as { workspaces?: unknown[] }).workspaces ?? []).length === 2, 'accepted invitation adds a second workspace context');

    // ---- explicit workspace switching and session rotation ----------------------------------
    const switchToA = await call(base, '/v1/auth/switch-workspace', { ...postJson({ workspaceId: alice.workspaceId }), headers: carolHeaders });
    assert(switchToA.status === 201, 'member of two workspaces explicitly switches workspaces');
    const switched = switchToA.body as { token: string; workspaceId: string; workspaces: { workspaceId: string }[] };
    assert(switched.workspaceId === alice.workspaceId && switched.workspaces.length === 2, 'switch returns the new workspace context and its list');
    const oldTokenAfterSwitch = await call(base, '/v1/auth/me', { headers: carolHeaders });
    assert(oldTokenAfterSwitch.status === 403 && errorCode(oldTokenAfterSwitch) === 'DENIED', 'the pre-switch token is invalidated by rotation');
    const newTokenMe = await call(base, '/v1/auth/me', { headers: auth(switched.token, switched.workspaceId) });
    assert(newTokenMe.status === 200 && ((newTokenMe.body as { roles?: string[] }).roles ?? []).join(',') === 'MEMBER', 'switched session resolves the target workspace role');
    const switchToForeign = await call(base, '/v1/auth/switch-workspace', { ...postJson({ workspaceId: bob.workspaceId }), headers: auth(switched.token, alice.workspaceId) });
    assert(switchToForeign.status === 403 && errorCode(switchToForeign) === 'DENIED', 'switching to a foreign workspace is refused');

    // ---- role changes and last-owner protection ---------------------------------------------
    const inviteBob = await call(base, '/v1/platform/organizations/' + alice.workspaceId + '/invitations', {
      ...postJson({ email: 'org-qa-bob@example.invalid', role: 'ADMIN', reason: 'organisation B collaboration request' }),
      headers: { authorization: 'Bearer ' + adminToken },
    });
    assert(inviteBob.status === 201, 'second organisation owner is invited as ADMIN');
    const bobInvitationId = (inviteBob.body as { membershipId: string }).membershipId;
    const bobInvites = await call(base, '/v1/invitations', { headers: bobHeaders });
    assert(items<{ membershipId: string }>(bobInvites).some(item => item.membershipId === bobInvitationId), 'multi-workspace user sees the new invitation');
    const bobAccept = await call(base, '/v1/invitations/' + bobInvitationId + '/accept', { method: 'POST', headers: bobHeaders });
    assert(bobAccept.status === 201 || bobAccept.status === 200, 'multi-workspace user accepts the second workspace');
    const bobSwitchA = await call(base, '/v1/auth/switch-workspace', { ...postJson({ workspaceId: alice.workspaceId }), headers: bobHeaders });
    const bobTokenA = (bobSwitchA.body as { token: string }).token;

    const aliceMembership = items<{ membershipId: string; email: string; role: string }>(membersA).find(member => member.role === 'OWNER');
    assert(aliceMembership !== undefined, 'owner membership identified');
    const bobMembersA = await call(base, '/v1/platform/organizations/' + alice.workspaceId + '/members?role=ADMIN', { headers: { authorization: 'Bearer ' + adminToken } });
    const bobMembership = items<{ membershipId: string; email: string }>(bobMembersA).find(member => member.email === 'org-qa-bob@example.invalid');
    assert(bobMembership !== undefined, 'invited member appears in the member list with the assigned role');

    const demoteLastOwner = await call(base, '/v1/platform/organizations/' + alice.workspaceId + '/members/' + (aliceMembership?.membershipId ?? '') + '/role', {
      ...postJson({ role: 'MEMBER', reason: 'last owner demotion attempt' }), headers: { authorization: 'Bearer ' + adminToken },
    });
    assert(demoteLastOwner.status === 403 && errorCode(demoteLastOwner) === 'DENIED', 'the last workspace owner cannot be demoted');
    const revokeLastOwner = await call(base, '/v1/platform/organizations/' + alice.workspaceId + '/members/' + (aliceMembership?.membershipId ?? '') + '/revoke', {
      ...postJson({ reason: 'last owner revocation attempt' }), headers: { authorization: 'Bearer ' + adminToken },
    });
    assert(revokeLastOwner.status === 403 && errorCode(revokeLastOwner) === 'DENIED', 'the last workspace owner cannot be revoked');

    const promoteBob = await call(base, '/v1/platform/organizations/' + alice.workspaceId + '/members/' + (bobMembership?.membershipId ?? '') + '/role', {
      ...postJson({ role: 'OWNER', reason: 'second owner for continuity' }), headers: { authorization: 'Bearer ' + adminToken },
    });
    assert(promoteBob.status === 200 || promoteBob.status === 201, 'a second owner can be promoted');
    const demoteAlice = await call(base, '/v1/platform/organizations/' + alice.workspaceId + '/members/' + (aliceMembership?.membershipId ?? '') + '/role', {
      ...postJson({ role: 'ADMIN', reason: 'ownership rotation completed' }), headers: { authorization: 'Bearer ' + adminToken },
    });
    assert(demoteAlice.status === 200 || demoteAlice.status === 201, 'the previous owner can be demoted once another owner exists');
    const bobMe = await call(base, '/v1/auth/me', { headers: auth(bobTokenA, alice.workspaceId) });
    assert(bobMe.status === 200 && ((bobMe.body as { roles?: string[] }).roles ?? []).includes('OWNER'), 'existing session resolves the new role without re-login');

    // ---- invitation decline / cancellation --------------------------------------------------
    const inviteDave = await call(base, '/v1/platform/organizations/' + alice.workspaceId + '/invitations', {
      ...postJson({ email: 'org-qa-dave@example.invalid', role: 'MEMBER', reason: 'temporary collaboration request' }),
      headers: { authorization: 'Bearer ' + adminToken },
    });
    const daveInvitationId = (inviteDave.body as { membershipId: string }).membershipId;
    const daveDecline = await call(base, '/v1/invitations/' + daveInvitationId + '/decline', { method: 'POST', headers: daveHeaders });
    assert(daveDecline.status === 201 || daveDecline.status === 200, 'invitee can decline an invitation');
    const daveAfterDecline = await call(base, '/v1/invitations', { headers: daveHeaders });
    assert(items(daveAfterDecline).length === 0, 'declined invitation leaves the inbox');
    const declinedCheck = connectDatabase(qa.url);
    try {
      const [declinedRow] = await declinedCheck.db.select({ value: count() }).from(identityMemberships)
        .where(and(eq(identityMemberships.workspaceId, alice.workspaceId), eq(identityMemberships.status, 'DECLINED')));
      assert(Number(declinedRow?.value ?? 0) === 1, 'declined invitation is retained as DECLINED history');
    } finally {
      await declinedCheck.close();
    }
    const reinviteDave = await call(base, '/v1/platform/organizations/' + alice.workspaceId + '/invitations', {
      ...postJson({ email: 'org-qa-dave@example.invalid', role: 'MEMBER', reason: 'collaboration request reissued' }),
      headers: { authorization: 'Bearer ' + adminToken },
    });
    assert(reinviteDave.status === 201, 'a declined invitation can be reissued without a new organisation entity');
    const daveReinviteId = (reinviteDave.body as { membershipId: string }).membershipId;
    const cancelInvite = await call(base, '/v1/platform/organizations/' + alice.workspaceId + '/members/' + daveReinviteId + '/revoke', {
      ...postJson({ reason: 'collaboration no longer required' }), headers: { authorization: 'Bearer ' + adminToken },
    });
    assert(cancelInvite.status === 200 || cancelInvite.status === 201, 'a pending invitation can be cancelled through revocation');
    const daveAfterCancel = await call(base, '/v1/invitations', { headers: daveHeaders });
    assert(items(daveAfterCancel).length === 0, 'cancelled invitation leaves the inbox');

    // ---- session invalidation when the last membership is revoked ---------------------------
    // Carol is OWNER of C and MEMBER of A. Invite Bob as OWNER of C, demote Carol, then revoke her.
    const carolMemberships = await call(base, '/v1/auth/workspaces', { headers: auth(switched.token, alice.workspaceId) });
    assert((carolMemberships.body as { workspaces?: unknown[] }).workspaces?.length === 2, 'carol holds two active workspaces before revocation');
    const inviteBobC = await call(base, '/v1/platform/organizations/' + carol.workspaceId + '/invitations', {
      ...postJson({ email: 'org-qa-bob@example.invalid', role: 'OWNER', reason: 'continuity owner for organisation C' }),
      headers: { authorization: 'Bearer ' + adminToken },
    });
    const bobCInvitationId = (inviteBobC.body as { membershipId: string }).membershipId;
    const bobAcceptC = await call(base, '/v1/invitations/' + bobCInvitationId + '/accept', { method: 'POST', headers: auth(bobSwitchA.body ? (bobSwitchA.body as { token: string }).token : bob.token, bob.workspaceId) });
    assert(bobAcceptC.status === 201 || bobAcceptC.status === 200, 'second owner accepts organisation C');
    const carolMembersC = await call(base, '/v1/platform/organizations/' + carol.workspaceId + '/members', { headers: { authorization: 'Bearer ' + adminToken } });
    const carolOwnership = items<{ membershipId: string; email: string; role: string }>(carolMembersC).find(member => member.email === 'org-qa-carol@example.invalid' && member.role === 'OWNER');
    assert(carolOwnership !== undefined, 'carol ownership of organisation C identified');
    const demoteCarolC = await call(base, '/v1/platform/organizations/' + carol.workspaceId + '/members/' + carolOwnership.membershipId + '/role', {
      ...postJson({ role: 'MEMBER', reason: 'ownership transferred to continuity owner' }), headers: { authorization: 'Bearer ' + adminToken },
    });
    assert(demoteCarolC.status === 200 || demoteCarolC.status === 201, 'ownership transfer permits demoting the former owner');
    const revokeCarolA = await call(base, '/v1/platform/organizations/' + alice.workspaceId + '/members/' + carolInvitation.membershipId + '/revoke', {
      ...postJson({ reason: 'collaboration ended' }), headers: { authorization: 'Bearer ' + adminToken },
    });
    assert(revokeCarolA.status === 200 || revokeCarolA.status === 201, 'membership revocation succeeds');
    const carolAfterA = await call(base, '/v1/auth/me', { headers: auth(switched.token, carol.workspaceId) });
    assert(carolAfterA.status === 200, 'revoking one membership keeps sessions valid while another membership remains');
    const revokeCarolC = await call(base, '/v1/platform/organizations/' + carol.workspaceId + '/members/' + carolOwnership.membershipId + '/revoke', {
      ...postJson({ reason: 'final membership removal' }), headers: { authorization: 'Bearer ' + adminToken },
    });
    assert(revokeCarolC.status === 200 || revokeCarolC.status === 201, 'the final membership can be revoked once another owner exists');
    const carolAfterAll = await call(base, '/v1/auth/me', { headers: auth(switched.token, carol.workspaceId) });
    assert(carolAfterAll.status === 403 && errorCode(carolAfterAll) === 'DENIED', 'losing the last membership invalidates existing workspace sessions');

    // ---- token acceptance unblocks a zero-membership account --------------------------------
    const carolLoginFrozen = await call(base, '/v1/auth/login', postJson({ email: 'org-qa-carol@example.invalid', password: 'workspace-passphrase' }));
    assert(carolLoginFrozen.status === 403 && errorCode(carolLoginFrozen) === 'DENIED', 'a zero-membership account cannot open a workspace session');
    const reinviteFrozen = await call(base, '/v1/platform/organizations/' + alice.workspaceId + '/invitations', {
      ...postJson({ email: 'org-qa-carol@example.invalid', role: 'MEMBER', reason: 're-onboarding after access review' }),
      headers: { authorization: 'Bearer ' + adminToken },
    });
    assert(reinviteFrozen.status === 201, 'a zero-membership account can be re-invited');
    const frozenInvitation = reinviteFrozen.body as { membershipId: string; invitationToken: string; delivery?: { email?: string } };
    assert(typeof frozenInvitation.invitationToken === 'string' && frozenInvitation.delivery?.email === 'BLOCKED', 'single-use acceptance token returned to the operator, e-mail delivery still blocked');
    const tokenAccept = await call(base, '/v1/invitations/token/accept', postJson({ token: frozenInvitation.invitationToken }));
    assert(tokenAccept.status === 201 || tokenAccept.status === 200, 'the invitation token can be accepted without a session');
    const tokenReuse = await call(base, '/v1/invitations/token/accept', postJson({ token: frozenInvitation.invitationToken }));
    assert(tokenReuse.status === 404 || tokenReuse.status === 409, 'the acceptance token is single-use');
    const carolLoginUnfrozen = await call(base, '/v1/auth/login', postJson({ email: 'org-qa-carol@example.invalid', password: 'workspace-passphrase' }));
    assert(carolLoginUnfrozen.status === 201, 'accepted invitation restores workspace login for the account');

    // ---- last enabled workspace owner cannot be suspended (Mission 02 cross-check) ----------
    const bobLookup = await call(base, '/v1/platform/users?query=org-qa-bob', { headers: { authorization: 'Bearer ' + adminToken } });
    const soleOwnerUserId = items<{ userId: string }>(bobLookup)[0]?.userId;
    assert(soleOwnerUserId !== undefined, 'sole owner account found in the user directory');
    const suspendSoleOwner = await call(base, '/v1/platform/users/' + soleOwnerUserId + '/suspend', {
      ...postJson({ reason: 'account suspension attempt on sole owner' }), headers: { authorization: 'Bearer ' + adminToken },
    });
    assert(suspendSoleOwner.status === 403 && errorCode(suspendSoleOwner) === 'DENIED', 'the last enabled workspace owner cannot be suspended');

    // ---- concurrent first invitations never produce a 500 ----------------------------------
    const eve = await registerUser(base, 'org-qa-eve@example.invalid', 'QA Org E');
    void eve;
    const concurrentInvites = await Promise.all([
      call(base, '/v1/platform/organizations/' + alice.workspaceId + '/invitations', {
        ...postJson({ email: 'org-qa-eve@example.invalid', role: 'MEMBER', reason: 'concurrent invitation attempt one' }),
        headers: { authorization: 'Bearer ' + adminToken },
      }),
      call(base, '/v1/platform/organizations/' + alice.workspaceId + '/invitations', {
        ...postJson({ email: 'org-qa-eve@example.invalid', role: 'MEMBER', reason: 'concurrent invitation attempt two' }),
        headers: { authorization: 'Bearer ' + adminToken },
      }),
    ]);
    const concurrentStatuses = concurrentInvites.map(result => result.status).sort();
    assert(concurrentStatuses.join(',') === '201,409', 'concurrent first invitations yield one success and one conflict, never a server error');
    assert(concurrentInvites.some(result => typeof (result.body as { invitationToken?: unknown }).invitationToken === 'string'), 'exactly one concurrent invitation carries the acceptance token');

    // ---- audit trail and preserved data ------------------------------------------------------
    const audit = await call(base, '/v1/platform/audit?limit=200', { headers: { authorization: 'Bearer ' + adminToken } });
    const auditRows = (audit.body as { action: string; outcome: string; targetId: string | null }[]) ?? [];
    assert(audit.status === 200 && auditRows.some(row => row.action === 'INVITE_WORKSPACE_MEMBER' && row.outcome === 'SUCCESS'), 'invitations are audited');
    assert(auditRows.some(row => row.action === 'CHANGE_MEMBERSHIP_ROLE' && row.outcome === 'SUCCESS'), 'role changes are audited');
    assert(auditRows.some(row => row.action === 'REVOKE_MEMBERSHIP' && row.outcome === 'SUCCESS'), 'revocations are audited');
    assert(auditRows.some(row => row.action === 'CHANGE_MEMBERSHIP_ROLE' && row.outcome === 'DENIED'), 'last-owner refusals are audited');
    const bobProfile = await call(base, '/v1/platform/users?query=org-qa-bob', { headers: { authorization: 'Bearer ' + adminToken } });
    const bobUserId = items<{ userId: string }>(bobProfile)[0]?.userId;
    assert(bobUserId !== undefined, 'user directory finds the invited account');
    const bobActivity = await call(base, '/v1/platform/users/' + bobUserId + '/activity?limit=50', { headers: { authorization: 'Bearer ' + adminToken } });
    const activityItems = (bobActivity.body as { items: { source: string; action: string }[] }).items ?? [];
    assert(activityItems.some(item => item.source === 'PLATFORM' && item.action === 'INVITE_WORKSPACE_MEMBER'), 'membership invitation appears in the account timeline');

    const inspection = connectDatabase(qa.url);
    try {
      const [workspacesCount] = await inspection.db.select({ value: count() }).from(identityWorkspaces);
      const [membershipsCount] = await inspection.db.select({ value: count() }).from(identityMemberships);
      const [revokedCount] = await inspection.db.select({ value: count() }).from(identityMemberships).where(eq(identityMemberships.status, 'REVOKED'));
      assert(Number(workspacesCount?.value ?? 0) >= 4, 'workspaces are preserved (no irreversible deletion)');
      assert(Number(membershipsCount?.value ?? 0) >= 4, 'memberships are retained after revocation');
      assert(Number(revokedCount?.value ?? 0) >= 1, 'REVOKED history is retained instead of deleted');
      const [ownerRows] = await inspection.db.select({ value: count() }).from(identityMemberships)
        .where(and(eq(identityMemberships.workspaceId, alice.workspaceId), eq(identityMemberships.role, 'OWNER'), eq(identityMemberships.status, 'ACTIVE')));
      assert(Number(ownerRows?.value ?? 0) === 1, 'exactly one active owner remains on organisation A');
    } finally {
      await inspection.close();
    }

    await app.close();
    app = undefined;
    console.log('Organizations & memberships e2e PASSED:', assertions, 'assertions against an isolated PostgreSQL database');
  } finally {
    if (app) await app.close().catch(() => undefined);
    await qa.drop();
    console.log('QA database dropped:', qa.name);
  }
}

main().catch((error: unknown) => {
  console.error('Organizations & memberships e2e FAILED:', error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});

/**
 * MISSION A21.05 — registration policy: real PostgreSQL + real HTTP API verification.
 *
 *   1. Pure policy resolution (`resolveRegistrationPolicy`): default CLOSED, the three modes, unsupported
 *      values fail closed, the deprecated QEYNOX_ALLOW_REGISTRATION alias, and QEYNOX_REGISTRATION_MODE
 *      precedence. `registrationAdmission` refusals.
 *   2. Web/API agreement matrix: for every configuration, `GET /v1/auth/registration-policy` (what the
 *      web register page renders) predicts exactly what `POST /v1/auth/register` does. The retired web
 *      switch QEYNOX_REGISTRATION_ENABLED=true is set throughout and changes nothing.
 *   3. Registration disabled (CLOSED): 503 NOT_CONFIGURED, nothing written, an invitation is not consumed.
 *   4. Registration enabled (OPEN): owner session, workspace + OWNER membership, password and input rules,
 *      the session works, and the uninvited workspace is NOT enrolled in the beta (no bypass).
 *   5. Operator issuance: ADMINISTRATION only, token shown once and stored as a SHA-256 digest only, no
 *      self-invitation, no invitation for an existing account, one pending invitation per e-mail, audit.
 *   6. Invalid invitations (INVITE_ONLY): missing, malformed, unknown, wrong e-mail, expired, revoked and
 *      already used are all the same 403 INVITATION_INVALID and write nothing.
 *   7. Valid invitation: account + workspace + OWNER membership + ACTIVE beta grant with the invited
 *      terms + ledger events, invitation REDEEMED, journey enrolled. OPEN + invitation behaves the same;
 *      OPEN + bad invitation is refused (never silently downgraded to an unenrolled signup).
 *   8. Duplicate e-mail: generic 409 in OPEN and INVITE_ONLY; a duplicate never consumes the invitation.
 *   9. Concurrency: two simultaneous redemptions of one invitation create exactly one account and grant.
 *
 * HONEST BOUNDARY: real PostgreSQL, real NestJS HTTP API, real services. Expiry is simulated by moving
 * stored timestamps into the past. No e-mail is sent (delivery is reported BLOCKED/MANUAL). No browser
 * runs here; the web register page is covered by the web smoke suite (fixture API) and screenshots.
 */
import 'reflect-metadata';
import { createHash, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { and, eq, sql } from 'drizzle-orm';
import {
  connectDatabase, runMigrations,
  betaGrantEvents, betaGrants, identityCredentials, identityMemberships, identityUsers, identityWorkspaces,
  platformAdminAssignments, platformAdminAudit, registrationInvitations,
} from '@qeynox/persistence';
import { registrationAdmission, resolveRegistrationPolicy } from '@qeynox/application';
import { DomainError } from '@qeynox/domain';
import { AppModule } from '../src/app.module';
import { DomainExceptionFilter } from '../src/transport/domain-exception.filter';
import { hashPassword } from '../src/auth/password';
import { createIsolatedQaDatabase } from './qa-isolated-database';

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
const code = (response: { body: Record<string, unknown> }) => (response.body.error as { code?: string } | undefined)?.code;
function refusedWith(code: string, run: () => unknown): boolean {
  try { run(); return false; } catch (error) { return error instanceof DomainError && error.code === code; }
}

const MODE = 'QEYNOX_REGISTRATION_MODE';
const LEGACY = 'QEYNOX_ALLOW_REGISTRATION';
function configure(mode: string | undefined, legacy?: string): void {
  if (mode === undefined) delete process.env[MODE]; else process.env[MODE] = mode;
  if (legacy === undefined) delete process.env[LEGACY]; else process.env[LEGACY] = legacy;
}
const password = 'qa-a2105-strong-passphrase';
const email = (label: string) => 'qa-a2105-' + label + '-' + randomUUID().slice(0, 8) + '@example.invalid';
const platformPassword = 'registration-qa-passphrase';
const operators = {
  admin: { id: 'registration-qa-admin', email: 'registration-admin@example.invalid', role: 'PLATFORM_ADMIN' },
  support: { id: 'registration-qa-support', email: 'registration-support@example.invalid', role: 'SUPPORT' },
} as const;

async function main(): Promise<void> {
  if (!process.env.QEYNOX_QA_DATABASE_URL) {
    console.log('BLOCKED: QEYNOX_QA_DATABASE_URL is not set. The registration QA suite requires an isolated PostgreSQL database; no result is claimed.');
    process.exitCode = 1;
    return;
  }
  const startedAt = Date.now();

  // ── Group 1 · pure policy resolution ────────────────────────────────────────────────────────────
  const resolved = (env: Record<string, string>) => resolveRegistrationPolicy(env);
  assert(resolved({}).mode === 'CLOSED' && resolved({}).source === 'DEFAULT' && resolved({}).acceptingRegistrations === false, 'unset resolves to CLOSED (default)');
  assert(resolved({ [MODE]: '  ' }).mode === 'CLOSED', 'blank resolves to CLOSED');
  assert(resolved({ [MODE]: 'CLOSED' }).mode === 'CLOSED' && resolved({ [MODE]: 'CLOSED' }).configurationError === null, 'explicit CLOSED');
  const invite = resolved({ [MODE]: 'INVITE_ONLY' });
  assert(invite.mode === 'INVITE_ONLY' && invite.acceptingRegistrations && invite.invitationRequired, 'INVITE_ONLY accepts registrations and requires an invitation');
  const open = resolved({ [MODE]: 'OPEN' });
  assert(open.mode === 'OPEN' && open.acceptingRegistrations && !open.invitationRequired, 'OPEN accepts registrations without an invitation');
  for (const bad of ['open', 'YES', 'true', 'PUBLIC', 'INVITE-ONLY']) {
    const policy = resolved({ [MODE]: bad });
    assert(policy.mode === 'CLOSED' && policy.configurationError === 'UNSUPPORTED_REGISTRATION_MODE', 'unsupported mode ' + bad + ' fails closed');
  }
  assert(resolved({ [LEGACY]: 'true' }).mode === 'OPEN' && resolved({ [LEGACY]: 'true' }).source === 'LEGACY_ALLOW_REGISTRATION', 'deprecated QEYNOX_ALLOW_REGISTRATION=true means OPEN');
  for (const legacy of ['false', '1', 'TRUE', 'yes']) assert(resolved({ [LEGACY]: legacy }).mode === 'CLOSED', 'deprecated alias value ' + legacy + ' means CLOSED');
  assert(resolved({ [MODE]: 'CLOSED', [LEGACY]: 'true' }).mode === 'CLOSED', 'QEYNOX_REGISTRATION_MODE wins over the alias (CLOSED)');
  assert(resolved({ [MODE]: 'INVITE_ONLY', [LEGACY]: 'true' }).mode === 'INVITE_ONLY', 'QEYNOX_REGISTRATION_MODE wins over the alias (INVITE_ONLY)');
  assert(resolved({ [MODE]: 'nonsense', [LEGACY]: 'true' }).mode === 'CLOSED', 'an unsupported mode is never rescued by the alias');
  assert(resolved({ QEYNOX_REGISTRATION_ENABLED: 'true' }).mode === 'CLOSED', 'the retired web switch is not an input of the policy');
  assert(refusedWith('NOT_CONFIGURED', () => registrationAdmission(resolved({}), 'A'.repeat(43))), 'CLOSED refuses even with a token');
  assert(refusedWith('INVITATION_INVALID', () => registrationAdmission(invite, undefined)), 'INVITE_ONLY refuses a missing token');
  assert(refusedWith('INVITATION_INVALID', () => registrationAdmission(invite, '   ')), 'INVITE_ONLY refuses a blank token');
  assert(refusedWith('INVITATION_INVALID', () => registrationAdmission(invite, 'short')), 'a malformed token is INVITATION_INVALID');
  assert(registrationAdmission(open, undefined).invitationTokenHash === undefined, 'OPEN without a token is an uninvited signup');
  assert(registrationAdmission(open, 'A'.repeat(43)).invitationTokenHash === createHash('sha256').update('A'.repeat(43)).digest('hex'), 'a presented token is redeemed by its SHA-256 digest');
  pass('policy resolution: default CLOSED, three modes, unsupported values fail closed, deprecated alias, MODE precedence');

  const qa = await createIsolatedQaDatabase();
  process.env.DATABASE_URL = qa.url;
  process.env.QEYNOX_COMMERCE_MODE = 'BETA_FREE';
  // The retired web-only switch, set to its most permissive value: it must change nothing.
  process.env.QEYNOX_REGISTRATION_ENABLED = 'true';
  configure(undefined);
  let connection: ReturnType<typeof connectDatabase> | undefined;
  let app: INestApplication | undefined;
  try {
    const report = await runMigrations(qa.url);
    assert(report.applied.length === report.total && report.applied.some(name => name.startsWith('0028_')), 'disposable database fully migrated, including 0028');
    connection = connectDatabase(qa.url);
    const db = connection.db;
    const credential = await hashPassword(platformPassword);
    for (const operator of Object.values(operators)) {
      await db.insert(identityUsers).values({ id: operator.id, email: operator.email, locale: 'en' });
      await db.insert(identityCredentials).values({ userId: operator.id, salt: credential.salt, passwordHash: credential.hash });
      await db.insert(platformAdminAssignments).values({ id: operator.id + '-assignment', userId: operator.id, role: operator.role, status: 'ACTIVE', grantedBy: 'QA_FIXTURE', grantReason: 'deterministic registration e2e seed' });
    }
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
    app.useGlobalFilters(new DomainExceptionFilter());
    await app.listen(0, '127.0.0.1');
    const base = 'http://127.0.0.1:' + String((app.getHttpServer().address() as { port: number }).port);
    const platformLogin = async (operator: { email: string }) => {
      const login = await http(base, '/v1/platform/auth/login', { json: { email: operator.email, password: platformPassword } });
      assert(login.status === 201, 'platform login ' + operator.email);
      return { authorization: 'Bearer ' + (login.body as { token: string }).token };
    };
    const admin = await platformLogin(operators.admin);
    const support = await platformLogin(operators.support);
    const userCount = async () => Number((await db.execute(sql`SELECT count(*)::int AS n FROM identity_users`)).rows[0]!.n);
    const register = (body: Record<string, unknown>) => http(base, '/v1/auth/register', { json: { password, workspaceName: 'QA A21.05 workspace', ...body } });
    const policy = async () => (await http(base, '/v1/auth/registration-policy')).body as { mode: string; acceptingRegistrations: boolean; invitationRequired: boolean };
    const betaIn = (in48h = 48) => new Date(Date.now() + in48h * 3_600_000).toISOString();
    const issue = (body: Record<string, unknown>, headers: Record<string, string> = admin) => http(base, '/v1/platform/registration-invitations', {
      headers, json: { betaExpiresAt: betaIn(30 * 24), missionQuota: 4, concurrentLimit: 2, maxProviderSpendMinor: 2500, currency: 'EUR', reason: 'Invite-only beta cohort for QA A21.05', ...body },
    });
    const journey = async (session: { token: string; workspaceId: string }) => (await http(base, '/v1/workspaces/current/beta-access/journey', {
      headers: { authorization: 'Bearer ' + session.token, 'x-qeynox-workspace': session.workspaceId },
    })).body as { state: string; account: { status: string; missionQuota: number | null; concurrentLimit: number | null; providerBudgetMinor: number | null; currency: string | null } };

    // ── Group 2 · web/API agreement matrix ─────────────────────────────────────────────────────────
    const matrix: [string, string | undefined, string | undefined, string][] = [
      ['unset', undefined, undefined, 'CLOSED'],
      ['CLOSED', 'CLOSED', undefined, 'CLOSED'],
      ['unsupported value', 'yes', undefined, 'CLOSED'],
      ['unsupported value + alias', 'yes', 'true', 'CLOSED'],
      ['legacy alias false', undefined, 'false', 'CLOSED'],
      ['legacy alias true', undefined, 'true', 'OPEN'],
      ['INVITE_ONLY', 'INVITE_ONLY', undefined, 'INVITE_ONLY'],
      ['INVITE_ONLY beats alias', 'INVITE_ONLY', 'true', 'INVITE_ONLY'],
      ['OPEN', 'OPEN', undefined, 'OPEN'],
    ];
    for (const [label, mode, legacy, expected] of matrix) {
      configure(mode, legacy);
      const served = await policy();
      assert(Object.keys(served).sort().join(',') === 'acceptingRegistrations,invitationRequired,mode', label + ': the public policy exposes only mode/acceptingRegistrations/invitationRequired');
      assert(served.mode === expected, label + ': served mode ' + served.mode + ' = ' + expected);
      const before = await userCount();
      const attempt = await register({ email: email('matrix') });
      const expectedStatus = !served.acceptingRegistrations ? 503 : served.invitationRequired ? 403 : 201;
      const expectedCode = !served.acceptingRegistrations ? 'NOT_CONFIGURED' : served.invitationRequired ? 'INVITATION_INVALID' : undefined;
      assert(attempt.status === expectedStatus && code(attempt) === expectedCode, label + ': register (no invitation) answered ' + String(attempt.status) + ' exactly as the served policy predicts');
      assert(await userCount() === before + (expectedStatus === 201 ? 1 : 0), label + ': an account is written only when the policy says so');
    }
    const anonymousPolicy = await http(base, '/v1/auth/registration-policy', { headers: { authorization: 'Bearer ' + 'x'.repeat(64) } });
    assert(anonymousPolicy.status === 200, 'the policy endpoint is public (an unknown bearer does not break it)');
    pass('web/API agreement: for 9 configurations the served policy predicts the register outcome exactly; QEYNOX_REGISTRATION_ENABLED=true changes nothing');

    // ── Group 5 (first: invitations are needed below) · operator issuance ─────────────────────────
    configure('INVITE_ONLY');
    const invitedEmail = email('invited');
    assert((await http(base, '/v1/platform/registration-invitations', { json: {} })).status === 403, 'issuing requires a platform session');
    const supportIssue = await issue({ email: email('support') }, support);
    assert(supportIssue.status === 403 && code(supportIssue) === 'DENIED', 'SUPPORT cannot issue (ADMINISTRATION only)');
    const supportList = await http(base, '/v1/platform/registration-invitations', { headers: support });
    assert(supportList.status === 200, 'SUPPORT can list invitations');
    const selfInvite = await issue({ email: operators.admin.email.toUpperCase() });
    assert(selfInvite.status === 403 && code(selfInvite) === 'DENIED', 'no self-invitation (case-insensitive)');
    const existingAccount = await issue({ email: operators.support.email });
    assert(existingAccount.status === 409 && code(existingAccount) === 'CONFLICT', 'no invitation for an e-mail that already has an account');
    assert((await issue({ email: invitedEmail, reason: 'short' })).status === 400, 'a justification is required');
    assert((await issue({ email: invitedEmail, missionQuota: 0 })).status === 400, 'beta terms are validated');
    assert((await issue({ email: invitedEmail, betaExpiresAt: new Date(Date.now() + 60_000).toISOString() })).status === 400, 'beta expiry must be at least 5 minutes ahead');
    const issued = await issue({ email: '  ' + invitedEmail.toUpperCase() + ' ' });
    assert(issued.status === 201, 'ADMINISTRATION issues an invitation (e-mail trimmed): ' + JSON.stringify(issued.body));
    const created = issued.body as unknown as { invitation: { invitationId: string; email: string; status: string; expiresAt: string; betaExpiresAt: string }; invitationToken: string; registrationPath: string; delivery: { email: string; reason: string } };
    const token = created.invitationToken;
    assert(/^[A-Za-z0-9_-]{43}$/.test(token), 'a 256-bit base64url token is returned once');
    assert(created.invitation.email === invitedEmail && created.invitation.status === 'PENDING', 'the invitation is bound to the normalised e-mail and PENDING');
    assert(created.registrationPath === '/en/account/register?invitation=' + token, 'the register link carries the token');
    assert(created.delivery.email === 'BLOCKED' && created.delivery.reason === 'MANUAL_DELIVERY_REQUIRED', 'no e-mail delivery is claimed');
    const ttl = Date.parse(created.invitation.expiresAt) - Date.now();
    assert(ttl > 6.9 * 86_400_000 && ttl <= 7 * 86_400_000 && Date.parse(created.invitation.betaExpiresAt) >= Date.parse(created.invitation.expiresAt), 'the invitation lives 7 days and never outlives the beta term');
    const [stored] = await db.select().from(registrationInvitations).where(eq(registrationInvitations.id, created.invitation.invitationId));
    assert(stored && stored.tokenHash === createHash('sha256').update(token).digest('hex') && stored.tokenHash !== token, 'only the SHA-256 digest is stored');
    const leaked = await db.execute(sql`SELECT count(*)::int AS n FROM platform_admin_audit WHERE detail::text LIKE ${'%' + token + '%'}`);
    assert(Number(leaked.rows[0]!.n) === 0, 'the token never enters the audit trail');
    const duplicatePending = await issue({ email: invitedEmail });
    assert(duplicatePending.status === 409, 'one PENDING invitation per e-mail');
    const audits = await db.select().from(platformAdminAudit).where(eq(platformAdminAudit.targetType, 'REGISTRATION_INVITATION'));
    assert(audits.some(row => row.action === 'ISSUE_REGISTRATION_INVITATION' && row.outcome === 'SUCCESS' && row.targetId === created.invitation.invitationId), 'issuance is audited');
    assert(audits.some(row => row.outcome === 'DENIED' && row.reason === 'SELF_INVITATION_FORBIDDEN'), 'the refused self-invitation is audited');
    assert(audits.some(row => row.outcome === 'DENIED' && row.reason === 'ACCOUNT_EXISTS'), 'the refused existing-account invitation is audited');
    pass('operator issuance: ADMINISTRATION only, token once + SHA-256 digest only, no self-invitation, no existing account, one pending per e-mail, audited');

    // ── Group 3 · registration disabled ────────────────────────────────────────────────────────────
    configure('CLOSED');
    let before = await userCount();
    const closedWithInvite = await register({ email: invitedEmail, invitationToken: token });
    assert(closedWithInvite.status === 503 && code(closedWithInvite) === 'NOT_CONFIGURED', 'CLOSED refuses even a valid invitation (503 NOT_CONFIGURED)');
    const closedBadInput = await register({ email: 'not-an-email', password: 'x' });
    assert(closedBadInput.status === 503, 'CLOSED refuses before reading input (no validation oracle)');
    const [stillPending] = await db.select().from(registrationInvitations).where(eq(registrationInvitations.id, created.invitation.invitationId));
    assert(await userCount() === before && stillPending?.status === 'PENDING', 'nothing is written and the invitation is not consumed');
    pass('registration disabled: 503 NOT_CONFIGURED for every request, nothing written, invitation untouched');

    // ── Group 4 · registration enabled (OPEN) ──────────────────────────────────────────────────────
    configure('OPEN');
    const openEmail = email('open');
    assert((await register({ email: openEmail, password: 'eleven-char' })).status === 400, 'password shorter than 12 characters is refused');
    assert((await register({ email: openEmail, password: 'x'.repeat(257) })).status === 400, 'password longer than 256 characters is refused');
    assert((await register({ email: openEmail, workspaceName: 'x' })).status === 400, 'workspace name shorter than 2 characters is refused');
    assert((await register({ email: 'not-an-email' })).status === 400, 'invalid e-mail is refused');
    before = await userCount();
    const opened = await register({ email: openEmail.toUpperCase(), password: 'y'.repeat(12) });
    assert(opened.status === 201, 'OPEN registration with a 12-character password succeeds');
    const openSession = opened.body as unknown as { token: string; userId: string; workspaceId: string; expiresAt: string; workspaces: { workspaceId: string; role: string }[] };
    const sessionTtl = Date.parse(openSession.expiresAt) - Date.now();
    assert(sessionTtl > 23.9 * 3_600_000 && sessionTtl <= 24 * 3_600_000, 'a 24-hour owner session is issued');
    assert(openSession.workspaces.length === 1 && openSession.workspaces[0]!.workspaceId === openSession.workspaceId && openSession.workspaces[0]!.role === 'OWNER', 'the response lists the new workspace with role OWNER');
    const [openUser] = await db.select().from(identityUsers).where(eq(identityUsers.id, openSession.userId));
    assert(openUser?.email === openEmail && openUser.verifiedAt === null, 'the e-mail is stored normalised and unverified');
    const [openWorkspace] = await db.select().from(identityWorkspaces).where(eq(identityWorkspaces.id, openSession.workspaceId));
    const [openMembership] = await db.select().from(identityMemberships).where(eq(identityMemberships.workspaceId, openSession.workspaceId));
    assert(openWorkspace?.createdBy === openSession.userId && openMembership?.role === 'OWNER' && openMembership.status === 'ACTIVE', 'workspace + ACTIVE OWNER membership created');
    const me = await http(base, '/v1/auth/me', { headers: { authorization: 'Bearer ' + openSession.token, 'x-qeynox-workspace': openSession.workspaceId } });
    assert(me.status === 200 && (me.body as { userId: string }).userId === openSession.userId, 'the issued session authenticates');
    assert((await db.select().from(betaGrants).where(eq(betaGrants.workspaceId, openSession.workspaceId))).length === 0, 'an uninvited signup gets NO beta grant');
    const openJourney = await journey(openSession);
    assert(openJourney.state === 'NOT_ENROLLED' && openJourney.account.status === 'NOT_ENROLLED', 'an uninvited workspace is NOT_ENROLLED (public signup does not bypass beta enrollment)');
    const login = await http(base, '/v1/auth/login', { json: { email: openEmail, password: 'y'.repeat(12) } });
    assert(login.status === 201, 'the new account can sign in');
    assert(await userCount() === before + 1, 'exactly one account written');
    pass('registration enabled (OPEN): password/input rules, normalised e-mail, workspace + OWNER, 24h session, sign-in, and NOT_ENROLLED (no beta bypass)');

    // ── Group 8a · duplicate e-mail (OPEN) ─────────────────────────────────────────────────────────
    before = await userCount();
    const duplicateOpen = await register({ email: openEmail.toUpperCase() });
    assert(duplicateOpen.status === 409 && code(duplicateOpen) === 'CONFLICT' && (duplicateOpen.body.error as { message: string }).message === 'Account could not be created', 'duplicate e-mail (any case) is a generic 409');
    assert(await userCount() === before, 'no account written for a duplicate');

    // ── Group 6 · invalid invitations (INVITE_ONLY) ────────────────────────────────────────────────
    configure('INVITE_ONLY');
    const invalid = async (label: string, body: Record<string, unknown>) => {
      const count = await userCount();
      const response = await register(body);
      assert(response.status === 403 && code(response) === 'INVITATION_INVALID', label + ' → 403 INVITATION_INVALID');
      assert(await userCount() === count, label + ' writes no account');
    };
    await invalid('missing invitation', { email: invitedEmail });
    await invalid('blank invitation', { email: invitedEmail, invitationToken: '   ' });
    await invalid('malformed invitation', { email: invitedEmail, invitationToken: 'not-a-token' });
    await invalid('unknown well-formed invitation', { email: invitedEmail, invitationToken: 'Z'.repeat(43) });
    await invalid('valid invitation, other e-mail', { email: email('other'), invitationToken: token });
    const expiredEmail = email('expired');
    const expiredIssued = (await issue({ email: expiredEmail })).body as unknown as { invitation: { invitationId: string }; invitationToken: string };
    await db.update(registrationInvitations).set({ createdAt: new Date(Date.now() - 9 * 86_400_000), expiresAt: new Date(Date.now() - 60_000) }).where(eq(registrationInvitations.id, expiredIssued.invitation.invitationId));
    await invalid('expired invitation', { email: expiredEmail, invitationToken: expiredIssued.invitationToken });
    const expiredList = await http(base, '/v1/platform/registration-invitations?status=EXPIRED', { headers: admin });
    assert((expiredList.body as { items: { invitationId: string }[] }).items.some(item => item.invitationId === expiredIssued.invitation.invitationId), 'the expired invitation is listed as EXPIRED');
    const revokeExpired = await http(base, '/v1/platform/registration-invitations/' + expiredIssued.invitation.invitationId + '/revoke', { headers: admin, json: { reason: 'Cohort closed for QA A21.05' } });
    assert(revokeExpired.status === 409, 'an expired invitation cannot be revoked');
    const reissued = await issue({ email: expiredEmail });
    assert(reissued.status === 201, 'an expired PENDING invitation does not block re-issuing (materialised EXPIRED)');
    const [materialised] = await db.select().from(registrationInvitations).where(eq(registrationInvitations.id, expiredIssued.invitation.invitationId));
    assert(materialised?.status === 'EXPIRED', 'the old invitation is stored EXPIRED');
    const revokedId = (reissued.body as unknown as { invitation: { invitationId: string } }).invitation.invitationId;
    const revokedToken = (reissued.body as unknown as { invitationToken: string }).invitationToken;
    assert((await http(base, '/v1/platform/registration-invitations/' + revokedId + '/revoke', { headers: support, json: { reason: 'Cohort closed for QA A21.05' } })).status === 403, 'SUPPORT cannot revoke');
    const revoked = await http(base, '/v1/platform/registration-invitations/' + revokedId + '/revoke', { headers: admin, json: { reason: 'Cohort closed for QA A21.05' } });
    assert(revoked.status === 201 && (revoked.body as { status: string }).status === 'REVOKED', 'ADMINISTRATION revokes a pending invitation');
    assert((await http(base, '/v1/platform/registration-invitations/' + revokedId + '/revoke', { headers: admin, json: { reason: 'Cohort closed for QA A21.05' } })).status === 409, 'revoking twice is a conflict');
    await invalid('revoked invitation', { email: expiredEmail, invitationToken: revokedToken });
    pass('invalid invitations: missing, blank, malformed, unknown, other e-mail, expired, revoked → one 403 INVITATION_INVALID, nothing written');

    // ── Group 7 · valid invitation ─────────────────────────────────────────────────────────────────
    before = await userCount();
    const redeemed = await register({ email: invitedEmail.toUpperCase(), invitationToken: '  ' + token + ' ', workspaceName: 'Invited QA workspace' });
    assert(redeemed.status === 201, 'a valid invitation (e-mail in any case, token trimmed) registers');
    const invitedSession = redeemed.body as unknown as { token: string; userId: string; workspaceId: string };
    assert(await userCount() === before + 1, 'exactly one account written');
    const [invitedMembership] = await db.select().from(identityMemberships).where(eq(identityMemberships.workspaceId, invitedSession.workspaceId));
    assert(invitedMembership?.userId === invitedSession.userId && invitedMembership.role === 'OWNER' && invitedMembership.status === 'ACTIVE', 'workspace + ACTIVE OWNER membership created');
    const grants = await db.select().from(betaGrants).where(eq(betaGrants.workspaceId, invitedSession.workspaceId));
    assert(grants.length === 1, 'exactly one beta grant for the new workspace');
    const grant = grants[0]!;
    assert(grant.status === 'ACTIVE' && grant.activatedBy === invitedSession.userId && grant.grantedBy === operators.admin.id && grant.invitationTokenHash === null, 'the grant is ACTIVE, granted by the issuing operator, activated by the registrant, with no second token');
    assert(grant.missionQuota === 4 && grant.concurrentLimit === 2 && grant.maxProviderSpendMinor === 2500 && grant.currency === 'EUR' && grant.expiresAt.toISOString() === created.invitation.betaExpiresAt, 'the grant carries exactly the invited terms');
    const events = await db.select().from(betaGrantEvents).where(eq(betaGrantEvents.grantId, grant.id));
    assert(events.map(event => event.kind).sort().join(',') === 'ACTIVATED,INVITED', 'the beta ledger records INVITED and ACTIVATED');
    assert(events.every(event => (event.detail as { registrationInvitationId?: string } | null)?.registrationInvitationId === created.invitation.invitationId), 'ledger events reference the invitation');
    const [redeemedRow] = await db.select().from(registrationInvitations).where(eq(registrationInvitations.id, created.invitation.invitationId));
    assert(redeemedRow?.status === 'REDEEMED' && redeemedRow.redeemedUserId === invitedSession.userId && redeemedRow.redeemedWorkspaceId === invitedSession.workspaceId && redeemedRow.betaGrantId === grant.id, 'the invitation is REDEEMED and linked to the account, workspace and grant');
    const invitedJourney = await journey(invitedSession);
    assert(invitedJourney.account.status === 'ACTIVE' && invitedJourney.account.missionQuota === 4 && invitedJourney.account.providerBudgetMinor === 2500 && invitedJourney.account.currency === 'EUR', 'the journey reports the workspace enrolled with the invited allowance');
    assert(invitedJourney.state === 'RUNTIME_UNAVAILABLE' || invitedJourney.state === 'ACTIVE', 'the journey state is past every enrollment state (runtime readiness decides the rest)');
    await invalid('already used invitation', { email: invitedEmail, invitationToken: token });
    // OPEN + invitation: enrolled the same way; OPEN + bad invitation is refused, not downgraded.
    configure('OPEN');
    const openInvitedEmail = email('open-invited');
    const openIssued = (await issue({ email: openInvitedEmail, missionQuota: 1 })).body as unknown as { invitationToken: string };
    await invalid('OPEN with an invalid invitation', { email: openInvitedEmail, invitationToken: 'Q'.repeat(43) });
    const openRedeemed = await register({ email: openInvitedEmail, invitationToken: openIssued.invitationToken });
    assert(openRedeemed.status === 201, 'OPEN with a valid invitation registers');
    const openGrant = await db.select().from(betaGrants).where(eq(betaGrants.workspaceId, (openRedeemed.body as { workspaceId: string }).workspaceId));
    assert(openGrant.length === 1 && openGrant[0]!.status === 'ACTIVE' && openGrant[0]!.missionQuota === 1, 'OPEN + invitation is enrolled with the invited terms');
    pass('valid invitation: account + workspace + OWNER + ACTIVE beta grant with the invited terms + ledger, invitation REDEEMED, single use; OPEN + invitation consistent');

    // ── Group 8b · duplicate e-mail never consumes an invitation ───────────────────────────────────
    const dupEmail = email('dup');
    const dupIssued = (await issue({ email: dupEmail })).body as unknown as { invitation: { invitationId: string }; invitationToken: string };
    assert((await register({ email: dupEmail })).status === 201, 'the e-mail registers uninvited while OPEN');
    configure('INVITE_ONLY');
    before = await userCount();
    const grantsBefore = Number((await db.execute(sql`SELECT count(*)::int AS n FROM beta_grants`)).rows[0]!.n);
    const duplicateInvited = await register({ email: dupEmail, invitationToken: dupIssued.invitationToken });
    assert(duplicateInvited.status === 409 && code(duplicateInvited) === 'CONFLICT' && (duplicateInvited.body.error as { message: string }).message === 'Account could not be created', 'duplicate e-mail with a valid invitation is the same generic 409');
    const [dupRow] = await db.select().from(registrationInvitations).where(eq(registrationInvitations.id, dupIssued.invitation.invitationId));
    assert(dupRow?.status === 'PENDING' && dupRow.redeemedAt === null, 'the invitation is NOT consumed (whole transaction rolled back)');
    assert(await userCount() === before && Number((await db.execute(sql`SELECT count(*)::int AS n FROM beta_grants`)).rows[0]!.n) === grantsBefore, 'no account and no beta grant written');
    pass('duplicate e-mail: generic non-enumerating 409 in OPEN and INVITE_ONLY; a duplicate never consumes the invitation');

    // ── Group 9 · concurrent redemption ────────────────────────────────────────────────────────────
    const raceEmail = email('race');
    const raceIssued = (await issue({ email: raceEmail })).body as unknown as { invitation: { invitationId: string }; invitationToken: string };
    const race = await Promise.all([1, 2, 3].map(() => register({ email: raceEmail, invitationToken: raceIssued.invitationToken })));
    const statuses = race.map(response => response.status).sort();
    assert(statuses.filter(status => status === 201).length === 1 && statuses.every(status => status === 201 || status === 403 || status === 409), 'three concurrent redemptions: exactly one 201 (' + statuses.join(',') + ')');
    const raceUsers = await db.select().from(identityUsers).where(eq(identityUsers.email, raceEmail));
    assert(raceUsers.length === 1, 'exactly one account');
    const raceWorkspaces = await db.select().from(identityWorkspaces).where(eq(identityWorkspaces.createdBy, raceUsers[0]!.id));
    const raceGrants = await db.select().from(betaGrants).where(and(eq(betaGrants.workspaceId, raceWorkspaces[0]!.id)));
    assert(raceWorkspaces.length === 1 && raceGrants.length === 1, 'exactly one workspace and one beta grant');
    pass('concurrency: one invitation, three simultaneous redemptions → one account, one workspace, one grant');

    console.log('Registration QA PASSED: ' + String(groups) + ' groups, ' + String(assertions) + ' assertions in ' + String(Math.round((Date.now() - startedAt) / 1000)) + 's');
    console.log('BOUNDARY: real PostgreSQL, real NestJS HTTP API and services; expiry by moving stored timestamps; no e-mail sent; no browser ran (web covered by smoke).');
  } finally {
    configure(undefined);
    delete process.env.QEYNOX_REGISTRATION_ENABLED;
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

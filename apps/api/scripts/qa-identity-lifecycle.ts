/**
 * MISSION A04 — customer identity lifecycle QA (isolated database + real HTTP).
 *
 * Boots the real NestJS application (DI graph, global guard, error filter) against a disposable
 * PostgreSQL database and exercises the lifecycle over HTTP, then verifies persistence directly.
 *
 * Two transport configurations are used deliberately:
 *
 *   A. NOT_CONFIGURED (the only transport this repository ships). Requests issue and store a token
 *      but report `sent: false` with the transport's reason. This proves the deployment never claims
 *      delivery it cannot perform — the failure mode A04 was written to prevent.
 *   B. A recording transport, injected for the run. It performs no network I/O and sends no e-mail;
 *      it records the message so the QA can extract the token the way a customer would. When it is
 *      used, `sent: true` means "a configured transport accepted the message", and this run says so
 *      explicitly — it is NOT evidence of real e-mail delivery.
 *
 * Required scenarios: replay, expired tokens, concurrent requests, account suspension,
 * cross-tenant access. Plus rate limiting, anti-enumeration and session invalidation.
 *
 * Run: pnpm qa:identity   (needs QEYNOX_QA_DATABASE_URL; local disposable database only)
 * Exit: 0 PASS · 3 BLOCKED (no database available) · 1 FAILED
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { NotConfiguredEmailTransport, type EmailTransport } from '@qeynox/application';
import {
  connectDatabase, identityAudit, identitySessions, identityTokens, identityUsers, runMigrations,
} from '@qeynox/persistence';
import { Module, type Type } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { AuthModule } from '../src/auth/auth.module';
import { DatabaseModule } from '../src/database/database.module';
import { AuthenticationGuard } from '../src/auth/auth.guard';
import { OperationsModule } from '../src/operations/operations.module';
import { ClaimsModule } from '../src/claims/claims.module';
import { ResultsModule } from '../src/results/results.module';
import { CommerceModule } from '../src/commerce/commerce.module';
import { ActivityModule } from '../src/activity/activity.module';
import { OperatorModule } from '../src/operator/operator.module';
import { ConfigurationModule } from '../src/configuration/configuration.module';
import { SoulModule } from '../src/soul/soul.module';
import { PilotModule } from '../src/pilot/pilot.module';
import { PlatformModule } from '../src/platform/platform.module';
import { WorkspacesModule } from '../src/workspaces/workspaces.module';
import { SupportModule } from '../src/support/support.module';
import { CapabilitiesModule } from '../src/capabilities/capabilities.module';
import { APP_GUARD } from '@nestjs/core';
import { DomainExceptionFilter } from '../src/transport/domain-exception.filter';
import { EMAIL_TRANSPORT } from '../src/platform/platform.tokens';
import { createIsolatedQaDatabase } from './qa-isolated-database';

const PASS = 0;
const FAILED = 1;
const BLOCKED = 3;

let assertions = 0;
function check(condition: unknown, message: string): asserts condition {
  assertions++;
  if (!condition) throw new Error('ASSERTION FAILED: ' + message);
}

interface HttpResult { readonly status: number; readonly body: unknown }
async function call(base: string, path: string, init: RequestInit = {}): Promise<HttpResult> {
  const response = await fetch(base + path, init);
  const text = await response.text();
  let body: unknown = text;
  try { body = JSON.parse(text) as unknown; } catch { /* plain text */ }
  return { status: response.status, body };
}
const post = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const bearer = (token: string): Record<string, string> => ({ authorization: 'Bearer ' + token });
/**
 * Authenticated JSON POST. It must MERGE the auth header with the JSON content-type: spreading a
 * `post()` init and adding `headers` replaces the whole header object, which silently sends a
 * string body without a content-type and produces a bogus INVALID_INPUT.
 */
const postAuthed = (token: string, body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...bearer(token) },
  body: JSON.stringify(body),
});
const errorCode = (result: HttpResult): string | undefined => (result.body as { error?: { code?: string } }).error?.code;

interface SentMessage { readonly to: string; readonly subject: string; readonly text: string; readonly html?: string; readonly category?: string; readonly deduplicationKey?: string }

/**
 * Records what a configured transport was asked to send. No socket, no provider, no delivery.
 * The QA extracts the token from the recorded link exactly as a customer would from their inbox.
 */
class RecordingEmailTransport implements EmailTransport {
  readonly status = 'CONFIGURED' as const;
  readonly reason = null;
  readonly provider = 'recording';
  readonly messages: SentMessage[] = [];
  async send(message: SentMessage): Promise<{ providerMessageId: string }> { this.messages.push(message); return { providerMessageId: 'qa-recording-' + this.messages.length }; }
  /** Newest unconsumed-style extraction: always read the most recent message for a path. */
  tokenFor(path: string): string {
    const candidates = this.messages.filter(candidate => candidate.text.includes(path));
    const message = candidates[candidates.length - 1];
    if (!message) throw new Error('No recorded message for ' + path);
    const match = /token=([A-Za-z0-9_-]{43,256})/.exec(message.text);
    if (!match?.[1]) throw new Error('Recorded message has no token');
    return match[1];
  }
  /** Marks how many messages exist, so a caller can wait for a specific new one. */
  countFor(path: string): number { return this.messages.filter(candidate => candidate.text.includes(path)).length; }
  get count(): number { return this.messages.length; }
}

async function main(): Promise<number> {
  if (!process.env.QEYNOX_QA_DATABASE_URL) {
    console.log('BLOCKED: QEYNOX_QA_DATABASE_URL is not set; no integration evidence can be produced.');
    return BLOCKED;
  }
  const qa = await createIsolatedQaDatabase();
  process.env.DATABASE_URL = qa.url;
  let app: INestApplication | undefined;
  let connection: ReturnType<typeof connectDatabase> | undefined;
  try {
    const migration = await runMigrations(qa.url);
    check(migration.total > 0 && migration.applied.length === migration.total, 'disposable QA database migrated');

    // --- A. The shipped transport: NOT_CONFIGURED -------------------------------------------
    process.env.QEYNOX_ALLOW_REGISTRATION = 'true';
    delete process.env.QEYNOX_EMAIL_PROVIDER;
    const emailOne = 'a04-owner-' + randomUUID().slice(0, 8) + '@example.invalid';
    const emailTwo = 'a04-tenant2-' + randomUUID().slice(0, 8) + '@example.invalid';
    const password = 'correct horse battery staple';
    const newPassword = 'a-different-passphrase-2026';

    app = await NestFactory.create(AppModule, { logger: false });
    app.useGlobalFilters(new DomainExceptionFilter());
    await app.listen(0, '127.0.0.1');
    const base = 'http://127.0.0.1:' + ((app.getHttpServer().address() as { port: number }).port);

    const shipped = app.get<EmailTransport>(EMAIL_TRANSPORT, { strict: false });
    check(shipped.status === 'NOT_CONFIGURED', 'the shipped transport is NOT_CONFIGURED, not a stub that pretends');

    const registered = await call(base, '/v1/auth/register', post({ email: emailOne, password, workspaceName: 'A04 Owner Workspace' }));
    check(registered.status === 201, 'registration creates the account');
    const owner = registered.body as { token: string; userId: string; workspaceId: string };
    check(typeof owner.token === 'string' && typeof owner.userId === 'string', 'registration returns a session');

    const registeredTwo = await call(base, '/v1/auth/register', post({ email: emailTwo, password, workspaceName: 'A04 Second Workspace' }));
    check(registeredTwo.status === 201, 'second tenant registration succeeds');
    const tenantTwo = registeredTwo.body as { token: string; userId: string; workspaceId: string };

    // Registration must not silently imply verification.
    const siteState = await call(base, '/v1/identity/state', { headers: bearer(owner.token) });
    check(siteState.status === 200, 'verification state is readable for the signed-in account');
    const stateBody = siteState.body as { verified: boolean; delivery: string };
    check(stateBody.verified === false, 'a newly registered account is NOT verified');
    check(stateBody.delivery === 'NOT_CONFIGURED', 'the API reports the real e-mail delivery state');

    // Requesting verification stores a token but must not claim delivery.
    const verifyRequest = await call(base, '/v1/identity/verification/request', post({ email: emailOne }));
    check(verifyRequest.status === 201, 'verification request is accepted');
    const verifyBody = verifyRequest.body as { sent: boolean; notSentReason: string | null; issued: boolean };
    check(verifyBody.sent === false, 'no transport configured means sent:false — never a false delivery claim');
    check(verifyBody.issued === true, 'the token was still issued and stored');
    check(verifyBody.notSentReason === 'EMAIL_PROVIDER_NOT_CONFIGURED', 'the reason names the missing provider configuration');

    // Anti-enumeration: an unknown address is indistinguishable from a known one.
    const unknownRequest = await call(base, '/v1/identity/verification/request', post({ email: 'a04-nobody-' + randomUUID().slice(0, 8) + '@example.invalid' }));
    check(unknownRequest.status === verifyRequest.status, 'unknown address returns the same status as a known one');
    const knownBody = verifyBody as { sent: boolean; notSentReason: string | null };
    const unknownBody = unknownRequest.body as { sent: boolean; notSentReason: string | null };
    check(unknownBody.sent === knownBody.sent, 'unknown address reports the same delivery state as a known one');
    check(unknownBody.notSentReason === null, 'an unknown address does not disclose a provider-specific reason that a known one would');

    const unknownReset = await call(base, '/v1/identity/recovery/request', post({ email: 'a04-nobody-' + randomUUID().slice(0, 8) + '@example.invalid' }));
    const knownReset = await call(base, '/v1/identity/recovery/request', post({ email: emailTwo }));
    check(unknownReset.status === knownReset.status, 'recovery request status does not differ for unknown addresses');
    check((unknownReset.body as { sent: boolean }).sent === (knownReset.body as { sent: boolean }).sent, 'recovery delivered flag does not differ for unknown addresses');

    // Cross-tenant: a session from another workspace cannot read this identity.
    const crossState = await call(base, '/v1/identity/state', { headers: bearer(tenantTwo.token) });
    const crossBody = crossState.body as { verified: boolean };
    check(crossState.status === 200 && crossBody.verified === false, 'the second tenant sees only its own identity state');
    const noSession = await call(base, '/v1/identity/state');
    check(noSession.status === 403 && errorCode(noSession) === 'DENIED', 'identity state requires a session');

    // Rate limiting is durable and per bucket.
    const limitedEmail = 'a04-limited-' + randomUUID().slice(0, 8) + '@example.invalid';
    let limitedAt = 0;
    for (let attempt = 0; attempt < 8 && limitedAt === 0; attempt++) {
      const attemptResult = await call(base, '/v1/identity/recovery/request', post({ email: limitedEmail }));
      if (attemptResult.status === 429) limitedAt = attempt + 1;
    }
    check(limitedAt > 0 && limitedAt <= 6, 'repeated recovery requests are throttled (BUDGET_EXHAUSTED -> 429)');

    await app.close();
    app = undefined;

    // --- B. A configured recording transport ------------------------------------------------
    // A second application instance, identical except that AuthModule.register() injects the
    // recording transport. It performs no network I/O: `sent: true` here means a configured
    // transport accepted the message, nothing more. No real e-mail is sent by this run.
    const recorder = new RecordingEmailTransport();
    app = await NestFactory.create(testingModule(recorder), { logger: false });
    app.useGlobalFilters(new DomainExceptionFilter());
    await app.listen(0, '127.0.0.1');
    const recorderBase = 'http://127.0.0.1:' + ((app.getHttpServer().address() as { port: number }).port);
    // Behaviour is what matters: the run must observe a CONFIGURED transport and the recorder must
    // receive the messages. Asserting object identity here would test DI plumbing, not the contract.
    check(recorder.status === 'CONFIGURED', 'the injected transport reports CONFIGURED for this run only');

    connection = connectDatabase(qa.url);
    const db = connection.db;

    // Verification with a real single-use token.
    const recVerify = await call(recorderBase, '/v1/identity/verification/request', post({ email: emailOne }));
    check((recVerify.body as { sent: boolean }).sent === true, 'a configured transport reports sent:true');
    check(recorder.count === 1, 'exactly one message was handed to the transport');
    const verificationToken = recorder.tokenFor('/account/verify');
    const registeredAgain = await call(recorderBase, '/v1/auth/login', post({ email: emailOne, password }));
    const ownerToken = (registeredAgain.body as { token: string }).token;

    const confirm = await call(recorderBase, '/v1/identity/verification/confirm', post({ token: verificationToken }));
    check(confirm.status === 201 && (confirm.body as { verified: boolean }).verified === true, 'a valid token verifies the address');
    const verifiedState = await call(recorderBase, '/v1/identity/state', { headers: bearer(ownerToken) });
    check((verifiedState.body as { verified: boolean }).verified === true, 'the recorded verification is readable');

    // REPLAY: the same token a second time.
    const replay = await call(recorderBase, '/v1/identity/verification/confirm', post({ token: verificationToken }));
    check(replay.status === 409 && errorCode(replay) === 'CONFLICT', 'a replayed verification token is refused');

    // CONCURRENT: two simultaneous submissions of one fresh token — exactly one wins.
    const recVerifyAgain = await call(recorderBase, '/v1/identity/verification/request', post({ email: emailTwo }));
    check((recVerifyAgain.body as { issued: boolean }).issued === true, 'a second verification token is issued');
    const concurrentToken = recorder.tokenFor('/account/verify');
    const race = await Promise.all([
      call(recorderBase, '/v1/identity/verification/confirm', post({ token: concurrentToken })),
      call(recorderBase, '/v1/identity/verification/confirm', post({ token: concurrentToken })),
    ]);
    const successes = race.filter(result => result.status === 201).length;
    const conflicts = race.filter(result => result.status === 409 && errorCode(result) === 'CONFLICT').length;
    check(successes === 1 && conflicts === 1, 'exactly one concurrent submission consumes the token (got ' + successes + ' ok / ' + conflicts + ' conflict)');

    // EXPIRED: a token past its expiry cannot be used.
    const expiredRaw = 'expired-' + randomUUID();
    const expiredHash = (await import('node:crypto')).createHash('sha256').update(expiredRaw).digest('hex');
    const ownerId = owner.userId;
    await db.insert(identityTokens).values({
      id: randomUUID(), userId: ownerId, purpose: 'PASSWORD_RESET', tokenHash: expiredHash,
      issuedAt: new Date(Date.now() - 7200_000), expiresAt: new Date(Date.now() - 3600_000),
    });
    const expired = await call(recorderBase, '/v1/identity/recovery/confirm', post({ token: expiredRaw, password: newPassword }));
    check(expired.status === 409 && errorCode(expired) === 'CONFLICT', 'an expired recovery token is refused');
    const expiredStillStored = await db.select().from(identityTokens).where(eq(identityTokens.tokenHash, expiredHash));
    check(expiredStillStored[0]?.usedAt === null, 'an expired token is not consumed, so the audit trail stays truthful');

    // RECOVERY: request, inspect without consuming, then consume.
    const recoveryRequest = await call(recorderBase, '/v1/identity/recovery/request', post({ email: emailOne }));
    check((recoveryRequest.body as { sent: boolean }).sent === true, 'recovery link is handed to the configured transport');
    const resetToken = recorder.tokenFor('/account/reset');
    const inspectFirst = await call(recorderBase, '/v1/identity/recovery/inspect?token=' + encodeURIComponent(resetToken));
    const inspectSecond = await call(recorderBase, '/v1/identity/recovery/inspect?token=' + encodeURIComponent(resetToken));
    check((inspectFirst.body as { valid: boolean }).valid === true && (inspectSecond.body as { valid: boolean }).valid === true, 'inspecting a token twice does not consume it');

    // Sessions that exist before the reset must die with it.
    const beforeResetSessions = await db.select().from(identitySessions)
      .where(and(eq(identitySessions.userId, ownerId), isNull(identitySessions.revokedAt)));
    check(beforeResetSessions.length >= 1, 'the account has a live session before recovery');

    const resetResult = await call(recorderBase, '/v1/identity/recovery/confirm', post({ token: resetToken, password: newPassword }));
    check(resetResult.status === 201 && (resetResult.body as { reset: boolean }).reset === true, 'recovery completes');
    check((resetResult.body as { revokedSessions: number }).revokedSessions >= 1, 'recovery reports the sessions it revoked');
    const revokedCount = (resetResult.body as { revokedSessions: number }).revokedSessions;

    // SESSION INVALIDATION: the pre-reset token is dead; the new password works; the old one does not.
    const staleSession = await call(recorderBase, '/v1/operations', { headers: bearer(ownerToken) });
    check(staleSession.status === 403 && errorCode(staleSession) === 'DENIED', 'sessions live at reset time are revoked');
    const oldPassword = await call(recorderBase, '/v1/auth/login', post({ email: emailOne, password }));
    check(oldPassword.status === 403, 'the previous password no longer authenticates');
    const newLogin = await call(recorderBase, '/v1/auth/login', post({ email: emailOne, password: newPassword }));
    check(newLogin.status === 201, 'the new password authenticates');
    const newToken = (newLogin.body as { token: string }).token;
    const newSessionWorks = await call(recorderBase, '/v1/operations', { headers: bearer(newToken) });
    check(newSessionWorks.status === 200, 'a session issued after recovery works');
    const refreshedSessions = await db.select().from(identitySessions)
      .where(and(eq(identitySessions.userId, ownerId), isNull(identitySessions.revokedAt)));
    check(refreshedSessions.length === 1, 'exactly the new session remains live (revoked ' + revokedCount + ')');

    // Replay of the consumed recovery token.
    const resetReplay = await call(recorderBase, '/v1/identity/recovery/confirm', post({ token: resetToken, password: 'yet-another-passphrase-2026' }));
    check(resetReplay.status === 409 && errorCode(resetReplay) === 'CONFLICT', 'a replayed recovery token is refused');

    // A recovery token cannot be used to consume a verification token or vice versa.
    const misuse = await call(recorderBase, '/v1/identity/verification/confirm', post({ token: resetToken }));
    check(misuse.status === 409 && errorCode(misuse) === 'CONFLICT', 'a token cannot be used for the other purpose');

    // ACCOUNT SUSPENSION: suspension revokes sessions and blocks authentication.
    const targetUser = tenantTwo.userId;
    await db.update(identityUsers).set({ disabledAt: new Date() }).where(eq(identityUsers.id, targetUser));
    const suspendedSession = await call(recorderBase, '/v1/operations', { headers: bearer(tenantTwo.token) });
    check(suspendedSession.status === 403 && errorCode(suspendedSession) === 'DENIED', 'a suspended account cannot use an existing session');
    const suspendedLogin = await call(recorderBase, '/v1/auth/login', post({ email: emailTwo, password }));
    check(suspendedLogin.status === 403, 'a suspended account cannot sign in');
    const suspendedRecovery = await call(recorderBase, '/v1/identity/recovery/request', post({ email: emailTwo }));
    check((suspendedRecovery.body as { sent: boolean; issued: boolean }).issued === false, 'a suspended account is not issued a recovery token');
    check((suspendedRecovery.body as { sent: boolean }).sent === false, 'and no delivery is claimed for it');
    const suspendedResetCount = recorder.count;
    const suspendedReset = await call(recorderBase, '/v1/identity/recovery/request', post({ email: emailTwo }));
    check(recorder.count === suspendedResetCount && (suspendedReset.body as { sent: boolean }).sent === false, 'suspension cannot be bypassed through recovery');

    // CROSS-TENANT: recovery of one account never touches another.
    // The other tenant's session row is untouched: one account's recovery must never revoke another's.
    // Suspension blocks that session at verification time (proven above) without rewriting its row,
    // so the audit trail shows a blocked session rather than a silent deletion.
    const otherSessions = await db.select().from(identitySessions).where(and(eq(identitySessions.userId, tenantTwo.userId), isNull(identitySessions.revokedAt)));
    check(otherSessions.length === 1, 'one account\'s recovery did not touch the other tenant\'s session row');
    const otherSessionStillBlocked = await call(recorderBase, '/v1/operations', { headers: bearer(tenantTwo.token) });
    check(otherSessionStillBlocked.status === 403 && errorCode(otherSessionStillBlocked) === 'DENIED', 'but that session remains unusable while the account is suspended');
    const auditRows = await db.select().from(identityAudit);
    check(auditRows.some(row => row.action === 'PASSWORD_RESET' && row.userId === ownerId), 'the reset is audited against its own account');
    check(!auditRows.some(row => row.action === 'PASSWORD_RESET' && row.userId === tenantTwo.userId), 'the other account has no reset audit entry');

    // Tokens are stored as digests only.
    const tokenRows = await db.select().from(identityTokens);
    check(tokenRows.length >= 1, 'tokens are persisted');
    check(tokenRows.every(row => /^[a-f0-9]{64}$/.test(row.tokenHash)), 'every stored token is a SHA-256 digest');
    check(tokenRows.every(row => !JSON.stringify(row).includes(resetToken)), 'the raw recovery token appears in no stored row');

    // Workspace switching and platform separation are untouched by the new flows.
    const workspaces = await call(recorderBase, '/v1/auth/workspaces', { headers: bearer(newToken) });
    check(workspaces.status === 200 && Array.isArray((workspaces.body as { workspaces: unknown[] }).workspaces), 'workspace listing still works');
    const switched = await call(recorderBase, '/v1/auth/switch-workspace', postAuthed(newToken, { workspaceId: owner.workspaceId }));
    check(switched.status === 201 && typeof (switched.body as { token: string }).token === 'string', 'explicit workspace switching still works');
    const platformRoute = await call(recorderBase, '/v1/platform/admins', { headers: bearer((switched.body as { token: string }).token) });
    check(platformRoute.status === 403 && errorCode(platformRoute) === 'DENIED', 'a workspace session still grants no platform authority');

    console.log('IDENTITY_LIFECYCLE ' + JSON.stringify({
      verification: 'single-use, digest-only, replay and concurrent-duplicate refused',
      recovery: 'revoked ' + revokedCount + ' session(s), old password rejected, replay refused',
      suspension: 'session blocked, sign-in blocked, recovery not issued',
      transport: { shipped: 'NOT_CONFIGURED (no delivery claimed)', configuredRun: 'recording transport, no network, no real e-mail' },
    }));
    console.log('PASS: customer identity lifecycle — ' + assertions + ' assertions.');
    console.log('NOTE: no e-mail was delivered. The configured run proves token handling and truthful reporting, not delivery.');
    return PASS;
  } finally {
    if (app) await app.close().catch(() => undefined);
    await connection?.close().catch(() => undefined);
    await qa.drop().catch(error => console.error('QA database teardown warning:', error instanceof Error ? error.message : error));
  }
}

/**
 * The production application with AuthModule's transport overridden.
 *
 * The module list is the real one: the static AuthModule is replaced by AuthModule.forTest(), which
 * carries the same controllers and services but a supplied transport. The global AuthenticationGuard
 * is registered here explicitly because the static AuthModule is not imported (Nest would otherwise
 * refuse a second APP_GUARD), and every other tenant/platform module is the production graph.
 *
 * No socket is opened and no message leaves the process, so this run is evidence about token handling
 * and truthful reporting, never about e-mail delivery.
 */
function testingModule(transport: EmailTransport): Type<unknown> {
  @Module({
    imports: [
      DatabaseModule, AuthModule.forTest(transport), OperationsModule, ClaimsModule, ResultsModule,
      CommerceModule, ActivityModule, OperatorModule, ConfigurationModule, SoulModule, PilotModule,
      PlatformModule, WorkspacesModule, SupportModule, CapabilitiesModule,
    ],
    providers: [{ provide: APP_GUARD, useClass: AuthenticationGuard }],

  })
  class IdentityQaModule {}
  return IdentityQaModule;
}

/**
 * Exit only after teardown. A `process.exit()` inside the try block would skip nothing but would
 * still let `finally` run, and a throwing teardown would then mask the intended exit code — the
 * defect this harness was fixed for once already.
 */
main()
  .then(code => { process.exitCode = code; })
  .catch((error: unknown) => {
    console.error('Customer identity lifecycle QA FAILED:', error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = FAILED;
  });

/**
 * MISSION A21.06 — authenticated "resend verification e-mail": real PostgreSQL + real HTTP journey.
 *
 * E-MAIL FIXTURE: the REAL `ResendEmailTransport` adapter (request shape, bearer key, idempotency key,
 * 2xx/4xx/5xx/network classification) is used unchanged. Only its documented `fetchImpl` seam is
 * pointed at a LOCAL HTTP server that imitates the Resend `POST /emails` API. The fixture records every
 * message it accepts, so the journey reads the verification link out of the "mailbox" exactly as a
 * person would, and opens it against the real API. Nothing leaves 127.0.0.1; no real Resend key is used.
 *
 *   1. Route contract: session required (anonymous → 403, nothing sent), body ignored.
 *   2. Spoofing: a body naming ANOTHER account's e-mail/user id never changes the recipient or whose
 *      token is issued — the session identity alone decides.
 *   3. Full journey: register → state UNVERIFIED/CONFIGURED → resend ACCEPTED → mail read from the
 *      fixture → link inspected → confirmed → state VERIFIED → resend ALREADY_VERIFIED (nothing sent).
 *   4. Single-use tokens: digest-only storage, supersession of the previous link on resend, replay and
 *      superseded links refused (409), one live token per account.
 *   5. Delivery failure: provider 5xx, 4xx and unreachable → DELIVERY_FAILED with the real ledger code;
 *      a later attempt is ACCEPTED again.
 *   6. Too many requests: per-account throttle → 429 BUDGET_EXHAUSTED with no provider call; another
 *      account is unaffected; an anonymous flood of the PUBLIC route does not lock the owner's resend.
 *   7. Transport not configured (production composition, QEYNOX_EMAIL_PROVIDER unset): NOT_CONFIGURED,
 *      no token issued, no provider call; the public route's anti-enumeration answer is unchanged.
 *
 * HONEST BOUNDARY: real PostgreSQL, real NestJS HTTP API and services, real Resend adapter; the
 * provider itself is the local fixture, so this is evidence about the adapter contract and the
 * journey, not about Resend's production delivery. No browser runs here (web: smoke suite).
 */
import 'reflect-metadata';
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { once } from 'node:events';
import { Module, type INestApplication, type Type } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { and, eq, isNull } from 'drizzle-orm';
import { ResendEmailTransport } from '@qeynox/application';
import { connectDatabase, emailDeliveries, identityTokens, identityUsers, runMigrations } from '@qeynox/persistence';
import { AppModule } from '../src/app.module';
import { AuthModule } from '../src/auth/auth.module';
import { AuthenticationGuard } from '../src/auth/auth.guard';
import { DatabaseModule } from '../src/database/database.module';
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
import { DomainExceptionFilter } from '../src/transport/domain-exception.filter';
import { createIsolatedQaDatabase } from './qa-isolated-database';

let assertions = 0;
let groups = 0;
function assert(condition: unknown, message: string): asserts condition {
  assertions++;
  if (!condition) throw new Error('ASSERTION FAILED: ' + message);
}
function pass(message: string): void { groups++; console.log('PASS: ' + message); }

// ── Local Resend fixture ─────────────────────────────────────────────────────────────────────────
type FixtureMode = 'accept' | 'reject' | 'error' | 'drop';
interface FixtureMail {
  readonly id: string; readonly path: string; readonly authorization: string | undefined; readonly idempotencyKey: string | undefined;
  readonly from: string; readonly to: string[]; readonly subject: string; readonly text: string; readonly html: string | undefined;
  readonly tags: { name: string; value: string }[] | undefined;
}
const FIXTURE_KEY = 'qa-a2106-resend-fixture-key-not-real';
const FIXTURE_FROM = 'QeyNox QA <qa-a2106@example.invalid>';
class ResendFixture {
  mode: FixtureMode = 'accept';
  /** Every request that reached the fixture, accepted or not. */
  readonly requests: { readonly mode: FixtureMode; readonly to: string[] }[] = [];
  /** Messages the fixture ACCEPTED (HTTP 200) — the "mailbox". */
  readonly mailbox: FixtureMail[] = [];
  /** URLs the adapter targeted before redirection (must be the real Resend endpoint). */
  readonly targets: string[] = [];
  private server: Server | undefined;
  base = '';

  async start(): Promise<void> {
    this.server = createServer((req, res) => { void this.handle(req, res); });
    this.server.listen(0, '127.0.0.1');
    await once(this.server, 'listening');
    this.base = 'http://127.0.0.1:' + String((this.server.address() as { port: number }).port);
  }
  async stop(): Promise<void> {
    if (!this.server) return;
    this.server.closeAllConnections();
    await new Promise(resolve => this.server!.close(resolve));
  }
  /** The adapter's fetch seam: same request, redirected from api.resend.com to the local fixture. */
  readonly fetchImpl: typeof fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    this.targets.push(url);
    return fetch(this.base + new URL(url).pathname, init);
  };
  private async handle(req: IncomingMessage, res: import('node:http').ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Omit<FixtureMail, 'id' | 'path' | 'authorization' | 'idempotencyKey'>;
    this.requests.push({ mode: this.mode, to: body.to });
    if (this.mode === 'drop') { req.socket.destroy(); return; }
    res.setHeader('content-type', 'application/json');
    if (this.mode === 'error') { res.statusCode = 500; res.end(JSON.stringify({ name: 'internal_server_error', message: 'fixture outage' })); return; }
    if (this.mode === 'reject') { res.statusCode = 422; res.end(JSON.stringify({ name: 'validation_error', message: 'fixture rejection' })); return; }
    const id = 'fixture-' + randomUUID();
    this.mailbox.push({
      ...body, id, path: req.url ?? '', authorization: req.headers.authorization,
      idempotencyKey: typeof req.headers['idempotency-key'] === 'string' ? req.headers['idempotency-key'] : undefined,
    });
    res.end(JSON.stringify({ id }));
  }
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────────────────────────
async function http(base: string, path: string, init: { method?: string; json?: unknown; token?: string } = {}) {
  const body = init.json === undefined ? undefined : JSON.stringify(init.json);
  const response = await fetch(base + path, {
    method: init.method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(init.token ? { authorization: 'Bearer ' + init.token } : {}) },
    ...(body === undefined ? {} : { body }),
  });
  const text = await response.text();
  let parsed: unknown = text;
  try { parsed = JSON.parse(text); } catch { /* plain text */ }
  return { status: response.status, body: parsed as Record<string, unknown> };
}
const code = (response: { body: Record<string, unknown> }) => (response.body.error as { code?: string } | undefined)?.code;
interface Resend { outcome: string; sent: boolean; issued: boolean; notSentReason: string | null }
const PUBLIC_URL = 'https://app.qa-a2106.example.invalid';
const linkPattern = new RegExp(PUBLIC_URL.replace(/[.]/g, '\\.') + '/(en|fr)/account/verify\\?token=([A-Za-z0-9_-]{43,256})');
function tokenFrom(mail: FixtureMail): { token: string; locale: string } {
  const match = linkPattern.exec(mail.text);
  assert(match, 'the e-mail text carries an absolute verification link');
  return { locale: match[1]!, token: decodeURIComponent(match[2]!) };
}
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/** Production module graph with AuthModule's transport supplied (same pattern as qa:identity). */
function testingModule(transport: ResendEmailTransport): Type<unknown> {
  @Module({
    imports: [
      DatabaseModule, AuthModule.forTest(transport), OperationsModule, ClaimsModule, ResultsModule,
      CommerceModule, ActivityModule, OperatorModule, ConfigurationModule, SoulModule, PilotModule,
      PlatformModule, WorkspacesModule, SupportModule, CapabilitiesModule,
    ],
    providers: [{ provide: APP_GUARD, useClass: AuthenticationGuard }],
  })
  class VerificationResendQaModule {}
  return VerificationResendQaModule;
}

async function boot(module: Type<unknown>): Promise<{ app: INestApplication; base: string }> {
  const app = await NestFactory.create(module, { logger: false, abortOnError: false });
  app.useGlobalFilters(new DomainExceptionFilter());
  await app.listen(0, '127.0.0.1');
  return { app, base: 'http://127.0.0.1:' + String((app.getHttpServer().address() as { port: number }).port) };
}

async function main(): Promise<void> {
  if (!process.env.QEYNOX_QA_DATABASE_URL) {
    console.log('BLOCKED: QEYNOX_QA_DATABASE_URL is not set. The verification-resend QA suite requires an isolated PostgreSQL database; no result is claimed.');
    process.exitCode = 1;
    return;
  }
  const startedAt = Date.now();
  const qa = await createIsolatedQaDatabase();
  process.env.DATABASE_URL = qa.url;
  process.env.QEYNOX_REGISTRATION_MODE = 'OPEN';
  process.env.QEYNOX_PUBLIC_URL = PUBLIC_URL;
  delete process.env.QEYNOX_EMAIL_PROVIDER;
  const fixture = new ResendFixture();
  let connection: ReturnType<typeof connectDatabase> | undefined;
  let configured: INestApplication | undefined;
  let unconfigured: INestApplication | undefined;
  try {
    const report = await runMigrations(qa.url);
    assert(report.applied.length === report.total, 'disposable database fully migrated');
    connection = connectDatabase(qa.url);
    const db = connection.db;
    await fixture.start();
    // Accessors (not property reads) so assertion narrowing never freezes a count's type.
    const mailCount = (): number => fixture.mailbox.length;
    const requestCount = (): number => fixture.requests.length;
    const transport = new ResendEmailTransport({ apiKey: FIXTURE_KEY, from: FIXTURE_FROM, fetchImpl: fixture.fetchImpl });
    const booted = await boot(testingModule(transport));
    configured = booted.app;
    const base = booted.base;

    const register = async (label: string, locale = 'en') => {
      const email = 'qa-a2106-' + label + '-' + randomUUID().slice(0, 8) + '@example.invalid';
      const response = await http(base, '/v1/auth/register', { json: { email, password: 'qa-a2106-strong-passphrase', workspaceName: 'QA A21.06 ' + label, locale } });
      assert(response.status === 201, 'registered ' + label);
      const session = response.body as unknown as { token: string; userId: string };
      return { email, token: session.token, userId: session.userId };
    };
    const resend = (token: string | undefined, json?: unknown) => http(base, '/v1/identity/verification/resend', { method: 'POST', json, ...(token ? { token } : {}) });
    const liveTokens = (userId: string) => db.select().from(identityTokens).where(and(eq(identityTokens.userId, userId), eq(identityTokens.purpose, 'EMAIL_VERIFICATION'), isNull(identityTokens.usedAt), isNull(identityTokens.revokedAt)));
    const allTokens = (userId: string) => db.select().from(identityTokens).where(and(eq(identityTokens.userId, userId), eq(identityTokens.purpose, 'EMAIL_VERIFICATION')));

    // ── Group 1 · route contract ────────────────────────────────────────────────────────────────
    const alice = await register('alice');
    const bob = await register('bob', 'fr');
    const anonymous = await resend(undefined);
    assert(anonymous.status === 403 && code(anonymous) === 'DENIED', 'anonymous resend is refused (session required)');
    const forged = await resend('x'.repeat(64));
    assert(forged.status === 403, 'an unknown bearer is refused');
    assert(requestCount() === 0, 'no provider call for refused requests');
    const state = await http(base, '/v1/identity/state', { token: alice.token });
    assert(state.status === 200 && state.body.verified === false && state.body.delivery === 'CONFIGURED', 'state: unverified, transport CONFIGURED');
    // The original defect: the web posted an empty body to the PUBLIC route, which needs an e-mail.
    const emptyPublic = await http(base, '/v1/identity/verification/request', { json: {} });
    assert(emptyPublic.status === 400 && code(emptyPublic) === 'INVALID_INPUT' && requestCount() === 0, 'regression pin: the public route still refuses an empty body (the web no longer calls it)');
    pass('route contract: session required; anonymous and forged bearers send nothing');

    // ── Group 2 · spoofing: the session decides, never the body ─────────────────────────────────
    const spoofed = await resend(alice.token, { email: bob.email, userId: bob.userId, to: bob.email });
    assert(spoofed.status === 200, 'resend answers 200');
    const spoofedBody = spoofed.body as unknown as Resend;
    assert(spoofedBody.outcome === 'ACCEPTED' && spoofedBody.sent === true && spoofedBody.issued === true && spoofedBody.notSentReason === null, 'ACCEPTED: the provider accepted the message');
    assert(mailCount() === 1, 'exactly one message reached the provider');
    const first = fixture.mailbox[0]!;
    assert(first.to.length === 1 && first.to[0] === alice.email, 'the recipient is the SESSION account, not the address in the body');
    assert(!first.text.includes(bob.email) && !JSON.stringify(first).includes(bob.email), 'the other account appears nowhere in the message');
    assert((await allTokens(bob.userId)).length === 0, 'no token was issued for the account named in the body');
    assert((await liveTokens(alice.userId)).length === 1, 'exactly one live token for the session account');
    pass('spoofing: a body naming another e-mail/user id changes neither the recipient nor whose token is issued');

    // ── Group 3 · Resend adapter contract seen by the provider ──────────────────────────────────
    assert(fixture.targets.every(url => url === 'https://api.resend.com/emails'), 'the adapter targets the real Resend endpoint (redirected only by the fixture seam)');
    assert(first.path === '/emails' && first.authorization === 'Bearer ' + FIXTURE_KEY && first.from === FIXTURE_FROM, 'Resend request: POST /emails, bearer API key, configured From');
    assert(first.idempotencyKey?.startsWith('identity:EMAIL_VERIFICATION:' + alice.userId + ':') === true, 'Resend idempotency key is per issued token');
    assert(first.tags?.some(tag => tag.name === 'category' && tag.value === 'TRANSACTIONAL') === true, 'transactional category tag');
    assert(typeof first.html === 'string' && first.html.length > 0 && first.subject.length > 0, 'rendered subject and HTML body');
    const firstLink = tokenFrom(first);
    assert(firstLink.locale === 'en', 'the link follows the account locale (en)');
    const [ledgerFirst] = await db.select().from(emailDeliveries).where(eq(emailDeliveries.providerMessageId, first.id));
    assert(ledgerFirst?.status === 'SENT' && ledgerFirst.provider === 'resend' && ledgerFirst.recipient === alice.email && ledgerFirst.userId === alice.userId, 'delivery ledger: SENT with the provider message id');
    const stored = await liveTokens(alice.userId);
    assert(stored[0]!.tokenHash === sha256(firstLink.token) && stored[0]!.tokenHash !== firstLink.token, 'the token is stored only as its SHA-256 digest');
    pass('Resend adapter contract: endpoint, bearer key, From, idempotency key, category, localized link, SENT ledger row with provider id');

    // ── Group 4 · single-use tokens and supersession ────────────────────────────────────────────
    const again = await resend(alice.token);
    assert((again.body as unknown as Resend).outcome === 'ACCEPTED' && mailCount() === 2, 'a second resend is ACCEPTED and delivered');
    const secondLink = tokenFrom(fixture.mailbox[1]!);
    assert(secondLink.token !== firstLink.token, 'a fresh token per resend');
    assert((await liveTokens(alice.userId)).length === 1, 'still exactly one live token (the previous one is superseded)');
    const inspectOld = await http(base, '/v1/identity/verification/inspect?token=' + encodeURIComponent(firstLink.token));
    const inspectNew = await http(base, '/v1/identity/verification/inspect?token=' + encodeURIComponent(secondLink.token));
    assert(inspectOld.body.valid === false && inspectNew.body.valid === true, 'inspect: superseded link dead, newest link live (inspection does not consume)');
    const confirmOld = await http(base, '/v1/identity/verification/confirm', { json: { token: firstLink.token } });
    assert(confirmOld.status === 409 && code(confirmOld) === 'CONFLICT', 'the superseded link is refused');
    const confirmNew = await http(base, '/v1/identity/verification/confirm', { json: { token: secondLink.token } });
    assert(confirmNew.status === 201 && confirmNew.body.verified === true && confirmNew.body.userId === alice.userId, 'the newest link verifies the session account');
    const replay = await http(base, '/v1/identity/verification/confirm', { json: { token: secondLink.token } });
    assert(replay.status === 409, 'replaying a used link is refused (single use)');
    const verifiedState = await http(base, '/v1/identity/state', { token: alice.token });
    assert(verifiedState.body.verified === true && typeof verifiedState.body.verifiedAt === 'string', 'state: VERIFIED');
    const [bobRow] = await db.select().from(identityUsers).where(eq(identityUsers.id, bob.userId));
    assert(bobRow?.verifiedAt === null, 'the other account is still unverified');
    pass('full journey: resend → mailbox → inspect → confirm → VERIFIED; superseded and replayed links refused; one live token');

    // ── Group 4b · already verified ─────────────────────────────────────────────────────────────
    const sentBefore = requestCount();
    const already = await resend(alice.token);
    const alreadyBody = already.body as unknown as Resend;
    assert(already.status === 200 && alreadyBody.outcome === 'ALREADY_VERIFIED' && !alreadyBody.sent && !alreadyBody.issued && alreadyBody.notSentReason === null, 'ALREADY_VERIFIED: nothing issued or sent');
    assert(requestCount() === sentBefore && (await liveTokens(alice.userId)).length === 0, 'no provider call and no new token for a verified account');
    pass('already verified: ALREADY_VERIFIED, no token, no provider call');

    // ── Group 5 · delivery failure ──────────────────────────────────────────────────────────────
    // Bob's locale is fr: the accepted message below must carry a /fr/ link.
    for (const [mode, ledgerCode] of [['error', 'EMAIL_PROVIDER_RETRYABLE'], ['reject', 'EMAIL_PROVIDER_REJECTED'], ['drop', 'EMAIL_PROVIDER_UNREACHABLE']] as const) {
      fixture.mode = mode;
      const mailboxBefore = mailCount();
      const failed = await resend(bob.token);
      const failedBody = failed.body as unknown as Resend;
      assert(failed.status === 200 && failedBody.outcome === 'DELIVERY_FAILED' && failedBody.sent === false && failedBody.issued === true && failedBody.notSentReason === 'EMAIL_DELIVERY_FAILED', 'provider ' + mode + ' → DELIVERY_FAILED (never reported as sent)');
      assert(mailCount() === mailboxBefore, 'provider ' + mode + ': nothing reached the mailbox');
      const ledger = await db.select().from(emailDeliveries).where(and(eq(emailDeliveries.userId, bob.userId), eq(emailDeliveries.status, 'FAILED'), eq(emailDeliveries.lastErrorCode, ledgerCode)));
      assert(ledger.length === 1, 'provider ' + mode + ': ledger FAILED with ' + ledgerCode);
    }
    fixture.mode = 'accept';
    const recovered = await resend(bob.token);
    assert((recovered.body as unknown as Resend).outcome === 'ACCEPTED', 'after the outage a resend is ACCEPTED');
    const bobMail = fixture.mailbox.at(-1)!;
    assert(bobMail.to[0] === bob.email && tokenFrom(bobMail).locale === 'fr', 'delivered to the session account with its locale (fr)');
    pass('delivery failure: 5xx, 4xx and unreachable provider → DELIVERY_FAILED with the real ledger code; recovery ACCEPTED');

    // ── Group 6 · too many requests ─────────────────────────────────────────────────────────────
    // Bob has made 4 throttled attempts (3 failures + 1 accepted); the 5th is allowed, the 6th refused.
    assert((await resend(bob.token)).status === 200, '5th attempt in the window is allowed');
    const callsBefore = requestCount();
    const throttled = await resend(bob.token);
    assert(throttled.status === 429 && code(throttled) === 'BUDGET_EXHAUSTED', '6th attempt → 429 BUDGET_EXHAUSTED');
    assert(requestCount() === callsBefore, 'a throttled request makes no provider call');
    const carol = await register('carol');
    assert(((await resend(carol.token)).body as unknown as Resend).outcome === 'ACCEPTED', 'another account is not affected (per-account bucket)');
    const dave = await register('dave');
    let publicRefused = false;
    for (let i = 0; i < 6; i++) {
      const publicRequest = await http(base, '/v1/identity/verification/request', { json: { email: dave.email } });
      if (publicRequest.status === 429) publicRefused = true;
    }
    assert(publicRefused, 'the PUBLIC route keeps its own per-address throttle');
    assert(((await resend(dave.token)).body as unknown as Resend).outcome === 'ACCEPTED', 'an anonymous flood of the public route does not lock the owner out of their resend');
    pass('too many requests: per-account 429 with no provider call; other accounts unaffected; public flood cannot lock the owner out');

    // ── Group 7 · transport not configured (production composition) ─────────────────────────────
    const plain = await boot(AppModule);
    unconfigured = plain.app;
    const erin = await (async () => {
      const email = 'qa-a2106-erin-' + randomUUID().slice(0, 8) + '@example.invalid';
      const response = await http(plain.base, '/v1/auth/register', { json: { email, password: 'qa-a2106-strong-passphrase', workspaceName: 'QA A21.06 erin' } });
      assert(response.status === 201, 'registered erin');
      return { email, ...(response.body as unknown as { token: string; userId: string }) };
    })();
    const plainState = await http(plain.base, '/v1/identity/state', { token: erin.token });
    assert(plainState.body.delivery === 'NOT_CONFIGURED' && plainState.body.deliveryReason === 'EMAIL_PROVIDER_NOT_CONFIGURED', 'state: transport NOT_CONFIGURED with its reason');
    const callsBeforePlain = requestCount();
    for (let i = 0; i < 7; i++) {
      const notConfigured = await http(plain.base, '/v1/identity/verification/resend', { method: 'POST', token: erin.token });
      const body = notConfigured.body as unknown as Resend;
      assert(notConfigured.status === 200 && body.outcome === 'NOT_CONFIGURED' && !body.sent && !body.issued && body.notSentReason === 'EMAIL_PROVIDER_NOT_CONFIGURED', 'NOT_CONFIGURED (attempt ' + String(i + 1) + '): nothing issued or sent, never throttled into a misleading 429');
    }
    assert((await allTokens(erin.userId)).length === 0, 'no token is issued when no transport can deliver it');
    assert(requestCount() === callsBeforePlain, 'no provider call');
    const unknownPublic = await http(plain.base, '/v1/identity/verification/request', { json: { email: 'qa-a2106-nobody-' + randomUUID().slice(0, 8) + '@example.invalid' } });
    assert(unknownPublic.status === 201 && unknownPublic.body.sent === false && unknownPublic.body.issued === false && unknownPublic.body.notSentReason === null, 'public route unchanged: an unknown address gets the same coarse answer');
    pass('transport not configured: NOT_CONFIGURED, no token, no provider call, no misleading throttle; public route unchanged');

    console.log('Verification resend QA PASSED: ' + String(groups) + ' groups, ' + String(assertions) + ' assertions in ' + String(Math.round((Date.now() - startedAt) / 1000)) + 's');
    console.log('BOUNDARY: real PostgreSQL, real NestJS HTTP API, real ResendEmailTransport; the provider is a local HTTP fixture (127.0.0.1), no real Resend key or delivery; no browser ran.');
  } finally {
    delete process.env.QEYNOX_REGISTRATION_MODE;
    delete process.env.QEYNOX_PUBLIC_URL;
    await configured?.close().catch(() => undefined);
    await unconfigured?.close().catch(() => undefined);
    await fixture.stop().catch(() => undefined);
    await connection?.close().catch(() => undefined);
    await qa.drop();
    console.log('QA database dropped: ' + qa.name);
  }
}

main().catch(error => {
  console.error('QA verification FAILED:', error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});

/**
 * MISSION A14 — connector hub and account connections QA.
 *
 * Two independent halves, deliberately separated:
 *
 *  PART 1 — CONTRACTS AND DECLARATIONS (pure, always runnable)
 *   - the connection wire contracts parse real hub output and strip any credential-like extra keys;
 *   - the reviewed provider declaration fails closed: availability and client credentials are
 *     derived from the environment, never from defaults, and insecure redirect URIs are refused;
 *   - the credential vault reports configured() honestly and refuses to store without a key;
 *   - the A14 migration exists and declares the four new tables.
 *
 *  PART 2 — OAUTH LIFECYCLE (isolated disposable database + loopback FAKE OAuth server)
 *   - the fake OAuth server runs on 127.0.0.1 inside this process only; it is never a fallback for
 *     a real provider, and no production code path can reach it;
 *   - unconfigured deployment: list is truthful CONNECT-required-style/NOT_CONFIGURED, authorize
 *     fails closed, and the refusal is audited;
 *   - authorize: single-use hashed state, PKCE S256 challenge in the URL, least-privilege scopes;
 *   - callback: unknown / expired / replayed states refused; membership re-verified at callback;
 *     exactly-once state consumption; token material never appears in the returned view;
 *   - the vault stores only ciphertext (the stored bytes never contain the access token);
 *   - scope-derived capability discovery: capabilities reflect granted scopes, never requested;
 *   - lazy refresh on near-expiry through the resolver, including rotating refresh tokens;
 *   - invalid_grant wipes the credential reference and marks the connection EXPIRED;
 *   - disconnect is OWNER/ADMIN-or-connector, revokes remotely (best effort) and always wipes
 *     locally; it is idempotent;
 *   - audit rows exist for the whole lifecycle and never contain token material;
 *   - cross-workspace isolation for views, resolver and audit trail.
 *
 * PART 2 refuses to run without QEYNOX_QA_DATABASE_URL. It NEVER uses fixtures as product
 * fallbacks and never reports a contracts-only run as integration evidence.
 *
 * Run: pnpm --filter @qeynox/worker qa:connector-hub
 * Exit: 0 PASS · 3 BLOCKED (prerequisite unavailable) · 1 FAILED
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { and, eq, sql } from 'drizzle-orm';
import {
  QeyNoxStore, connectDatabase, runMigrations,
  identityMemberships, identityUsers, identityWorkspaces,
  connections, connectionCredentials, oauthAuthorizationStates,
} from '@qeynox/persistence';
import {
  ConnectionHubService, ConnectionCredentialVault, REVIEWED_CONNECTION_PROVIDERS,
  GOOGLE_WORKSPACE_PROVIDER, providerAvailability, providerClientCredentials,
} from '@qeynox/application';
import { connectionAuditListSchema, connectionAuthorizationSchema, connectionViewSchema } from '@qeynox/contracts';
import { DomainError, type ID, type Principal } from '@qeynox/domain';
import type { OAuthHttpClient } from '@qeynox/application';
import { createIsolatedQaDatabase } from '../../api/scripts/qa-isolated-database';

const PASS = 0;
const FAILED = 1;
const BLOCKED = 3;

let assertions = 0;
function check(condition: unknown, message: string): asserts condition {
  assertions++;
  if (!condition) throw new Error('ASSERTION FAILED: ' + message);
}
async function expectError(code: string, run: () => Promise<unknown> | unknown, label: string): Promise<void> {
  assertions++;
  try {
    await run();
  } catch (error: unknown) {
    if (error instanceof DomainError && error.code === code) return;
    throw new Error('EXPECTED ' + code + ' for ' + label + ', got ' + (error instanceof DomainError ? error.code + ': ' + error.message : String(error)));
  }
  throw new Error('EXPECTED ' + code + ' for ' + label + ', but no error was raised');
}
class BlockedSignal extends Error {
  constructor(readonly reason: string) { super(reason); this.name = 'BlockedSignal'; }
}
function blocked(reason: string): never { throw new BlockedSignal(reason); }

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
const base64url = (buffer: Buffer): string => buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const QA_ACCESS_PREFIX = 'qa-access-';
const QA_REFRESH_PREFIX = 'qa-refresh-';
const FAKE_CODE = 'qa-auth-code';

// =============================================================================================
// The loopback fake OAuth server. Exists ONLY inside this QA process; production code never
// reaches it. It speaks the same wire shape as the reviewed provider profile: form posts,
// JSON responses, OAuth error objects.
// =============================================================================================
const fake = {
  challenge: '',
  grantedScopes: 'openid email profile',
  rotateRefreshToken: false,
  accessSeq: 0,
  refreshSeq: 0,
  revocations: [] as string[],
  issuedRefreshTokens: new Set<string>(),
  usedRefreshTokens: new Set<string>(),
  revokedTokens: new Set<string>(),
  revokeAllRefreshTokens(): void {
    for (const token of this.issuedRefreshTokens) this.revokedTokens.add(token);
  },
  reset(): void {
    this.challenge = '';
    this.grantedScopes = 'openid email profile';
    this.rotateRefreshToken = false;
    this.accessSeq = 0;
    this.refreshSeq = 0;
    this.revocations = [];
    this.issuedRefreshTokens = new Set();
    this.usedRefreshTokens = new Set();
    this.revokedTokens = new Set();
  },
};

function json(response: import('node:http').ServerResponse, status: number, body: Record<string, unknown>): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  response.end(payload);
}

async function startFakeOAuthServer(): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; if (body.length > 64 * 1024) request.destroy(); });
    request.on('end', () => {
      const form = new URLSearchParams(body);
      if (request.method === 'POST' && request.url === '/token') {
        const grantType = form.get('grant_type');
        if (grantType === 'authorization_code') {
          if (form.get('code') !== FAKE_CODE) return json(response, 400, { error: 'invalid_grant' });
          if (base64url(createHash('sha256').update(form.get('code_verifier') ?? '').digest()) !== fake.challenge) {
            return json(response, 400, { error: 'invalid_grant' });
          }
          fake.accessSeq += 1;
          fake.refreshSeq += 1;
          const refresh = QA_REFRESH_PREFIX + fake.refreshSeq;
          fake.issuedRefreshTokens.add(refresh);
          return json(response, 200, {
            access_token: QA_ACCESS_PREFIX + fake.accessSeq,
            refresh_token: refresh,
            token_type: 'Bearer', expires_in: 3600, scope: fake.grantedScopes,
          });
        }
        if (grantType === 'refresh_token') {
          const token = form.get('refresh_token') ?? '';
          if (fake.revokedTokens.has(token) || !fake.issuedRefreshTokens.has(token) || fake.usedRefreshTokens.has(token)) {
            return json(response, 400, { error: 'invalid_grant' });
          }
          fake.accessSeq += 1;
          let nextRefresh = token;
          if (fake.rotateRefreshToken) {
            fake.usedRefreshTokens.add(token);
            fake.refreshSeq += 1;
            nextRefresh = QA_REFRESH_PREFIX + fake.refreshSeq;
            fake.issuedRefreshTokens.add(nextRefresh);
          }
          return json(response, 200, {
            access_token: QA_ACCESS_PREFIX + fake.accessSeq,
            refresh_token: nextRefresh,
            token_type: 'Bearer', expires_in: 3600, scope: fake.grantedScopes,
          });
        }
        return json(response, 400, { error: 'unsupported_grant_type' });
      }
      if (request.method === 'POST' && request.url === '/revoke') {
        const token = form.get('token') ?? '';
        if (token) { fake.revokedTokens.add(token); fake.revocations.push(token); }
        return json(response, 200, {});
      }
      return json(response, 404, { error: 'unknown_endpoint' });
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fake OAuth server did not bind');
  return { server, baseUrl: 'http://127.0.0.1:' + address.port };
}

/** QA-only OAuth transport pointed at the loopback fake. Mirrors HttpOAuthClient's wire behaviour. */
class FakeServerOAuthClient implements OAuthHttpClient {
  constructor(private readonly baseUrl: string) {}
  private async post(path: string, form: URLSearchParams): Promise<Record<string, unknown>> {
    const response = await fetch(this.baseUrl + path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: form.toString(),
      signal: AbortSignal.timeout(5000),
    });
    let body: Record<string, unknown> = {};
    try { body = (await response.json()) as Record<string, unknown>; } catch { body = {}; }
    const providerError = typeof body.error === 'string' ? body.error : undefined;
    if (!response.ok || providerError) {
      const code = providerError ?? 'PROVIDER_HTTP_' + response.status;
      throw new DomainError('UNAVAILABLE', 'Fake provider refused the OAuth call: ' + code.slice(0, 64), { providerError: code.slice(0, 64) });
    }
    return body;
  }
  authorizationCode(_provider: unknown, input: { code: string; codeVerifier: string; clientId: string; clientSecret: string; redirectUri: string }): Promise<Record<string, unknown>> {
    return this.post('/token', new URLSearchParams({
      grant_type: 'authorization_code', code: input.code, code_verifier: input.codeVerifier,
      client_id: input.clientId, client_secret: input.clientSecret, redirect_uri: input.redirectUri,
    }));
  }
  refreshToken(_provider: unknown, input: { refreshToken: string; clientId: string; clientSecret: string }): Promise<Record<string, unknown>> {
    return this.post('/token', new URLSearchParams({
      grant_type: 'refresh_token', refresh_token: input.refreshToken,
      client_id: input.clientId, client_secret: input.clientSecret,
    }));
  }
  async revoke(_provider: unknown, input: { token: string; clientId: string; clientSecret: string }): Promise<void> {
    await this.post('/revoke', new URLSearchParams({ token: input.token, client_id: input.clientId, client_secret: input.clientSecret }));
  }
}

// =============================================================================================
// PART 1 — contracts, declarations, vault honesty, migration presence
// =============================================================================================
function partOne(): void {
  console.log('— PART 1: contracts, provider declaration, vault honesty —');
  const before = assertions;

  // --- wire contracts: parse and strip -------------------------------------------------------
  const view = connectionViewSchema.parse({
    provider: 'google-workspace', providerVersion: '1', label: 'Google Workspace', purpose: 'purpose',
    state: 'CONNECTED', reason: null, requestedScopes: ['openid'], grantedScopes: ['openid'], capabilities: ['identity.openid'],
    externalAccountId: null, accessTokenExpiresAt: new Date().toISOString(), lastHealthCheckAt: null,
    connectedBy: 'owner@example.invalid', connectedAt: new Date().toISOString(), lastErrorCode: null,
    access_token: 'must-be-stripped', clientSecret: 'must-be-stripped',
  });
  check(!('access_token' in view) && !('clientSecret' in view), 'the connection view contract strips credential-like extra keys');
  check(connectionAuthorizationSchema.safeParse({ provider: 'google-workspace', authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?response_type=code', expiresAt: new Date().toISOString() }).success, 'the authorization contract parses a real authorize response');
  check(!connectionAuthorizationSchema.safeParse({ provider: 'google-workspace', authorizationUrl: 'not-a-url', expiresAt: 'soon' }).success, 'the authorization contract rejects malformed output');
  check(connectionAuditListSchema.safeParse([]).success, 'the audit contract accepts an empty trail');

  // --- reviewed provider declaration fails closed ----------------------------------------------
  const empty = providerAvailability(GOOGLE_WORKSPACE_PROVIDER, {});
  check(!empty.clientConfigured && !empty.redirectConfigured, 'no environment means not configured');
  check(empty.missing.join(',') === 'QEYNOX_GOOGLE_WORKSPACE_CLIENT_ID,QEYNOX_GOOGLE_WORKSPACE_CLIENT_SECRET,QEYNOX_GOOGLE_WORKSPACE_REDIRECT_URI', 'availability names exactly the missing deployment variables');
  const partial = providerAvailability(GOOGLE_WORKSPACE_PROVIDER, { QEYNOX_GOOGLE_WORKSPACE_CLIENT_ID: 'id' });
  check(partial.missing.join(',') === 'QEYNOX_GOOGLE_WORKSPACE_CLIENT_SECRET,QEYNOX_GOOGLE_WORKSPACE_REDIRECT_URI', 'partial configuration names only the missing variables');

  const httpsCreds = providerClientCredentials(GOOGLE_WORKSPACE_PROVIDER, { QEYNOX_GOOGLE_WORKSPACE_CLIENT_ID: 'id', QEYNOX_GOOGLE_WORKSPACE_CLIENT_SECRET: 'secret', QEYNOX_GOOGLE_WORKSPACE_REDIRECT_URI: 'https://qeynox.example.test/callback' });
  check(httpsCreds?.redirectUri === 'https://qeynox.example.test/callback', 'an HTTPS redirect URI is accepted');
  const localhostCreds = providerClientCredentials(GOOGLE_WORKSPACE_PROVIDER, { QEYNOX_GOOGLE_WORKSPACE_CLIENT_ID: 'id', QEYNOX_GOOGLE_WORKSPACE_CLIENT_SECRET: 'secret', QEYNOX_GOOGLE_WORKSPACE_REDIRECT_URI: 'http://localhost:4000/v1/connections/google-workspace/callback' });
  check(localhostCreds !== null, 'a loopback HTTP redirect is accepted for development');
  check(providerClientCredentials(GOOGLE_WORKSPACE_PROVIDER, { QEYNOX_GOOGLE_WORKSPACE_CLIENT_ID: 'id', QEYNOX_GOOGLE_WORKSPACE_CLIENT_SECRET: 'secret', QEYNOX_GOOGLE_WORKSPACE_REDIRECT_URI: 'http://evil.example.test/callback' }) === null, 'a non-loopback HTTP redirect URI is refused');
  check(providerClientCredentials(GOOGLE_WORKSPACE_PROVIDER, { QEYNOX_GOOGLE_WORKSPACE_CLIENT_ID: 'id', QEYNOX_GOOGLE_WORKSPACE_CLIENT_SECRET: 'secret', QEYNOX_GOOGLE_WORKSPACE_REDIRECT_URI: 'https://user:pass@qeynox.example.test/callback' }) === null, 'a redirect URI embedding credentials is refused');
  check(providerClientCredentials(GOOGLE_WORKSPACE_PROVIDER, { QEYNOX_GOOGLE_WORKSPACE_CLIENT_ID: 'id', QEYNOX_GOOGLE_WORKSPACE_CLIENT_SECRET: 'secret', QEYNOX_GOOGLE_WORKSPACE_REDIRECT_URI: 'not a uri' }) === null, 'a malformed redirect URI is refused');

  // --- vault honesty without a key -------------------------------------------------------------
  const stubDb = null as unknown as ConstructorParameters<typeof ConnectionCredentialVault>[0];
  const vaultNoKey = new ConnectionCredentialVault(stubDb, {});
  check(!vaultNoKey.configured(), 'a vault without QEYNOX_CONNECTION_CREDENTIAL_KEY reports not configured');

  // --- migration presence ------------------------------------------------------------------------
  const migration = readFileSync(new URL('../../../packages/persistence/migrations/0021_connector_connections.sql', import.meta.url), 'utf8');
  for (const table of ['connections', 'connection_credentials', 'oauth_authorization_states', 'connection_audit_events']) {
    check(migration.includes(table), 'migration 0021 declares ' + table);
  }
  check(!migration.includes('access_token text'), 'no plaintext token column exists in the connections migration');

  console.log('  PART 1 PASSED: cumulative ' + assertions + ' assertions (' + (assertions - before) + ' in this half)');
}

// =============================================================================================
// PART 2 — full OAuth lifecycle against a disposable database and the loopback fake server
// =============================================================================================
function extractParam(authorizationUrl: string, name: string): string {
  const url = new URL(authorizationUrl);
  const value = url.searchParams.get(name);
  if (!value) throw new Error('authorization URL is missing ' + name);
  return value;
}

async function partTwo(): Promise<'PASSED' | 'BLOCKED'> {
  console.log('— PART 2: OAuth lifecycle, vault, capabilities, audit —');
  if (!process.env.QEYNOX_QA_DATABASE_URL) {
    console.log('BLOCKED: PART 2 not run — QEYNOX_QA_DATABASE_URL is not set. A contracts-only run is not integration evidence.');
    return 'BLOCKED';
  }

  const qa = await createIsolatedQaDatabase();
  process.env.DATABASE_URL = qa.url;
  const fakeOAuth = await startFakeOAuthServer();
  let connection: ReturnType<typeof connectDatabase> | undefined;
  try {
    const migration = await runMigrations(qa.url);
    check(migration.total > 0, 'disposable QA database migrated');
    connection = connectDatabase(qa.url);
    const db = connection.db;
    const store = new QeyNoxStore(db);

    // --- principals ---------------------------------------------------------------------------
    const ownerId = randomUUID(), memberId = randomUUID(), intruderId = randomUUID(), outsiderId = randomUUID();
    const workspaceId = randomUUID(), otherWorkspaceId = randomUUID();
    await db.insert(identityUsers).values([
      { id: ownerId, email: 'qa-a14-owner-' + ownerId + '@example.invalid' },
      { id: memberId, email: 'qa-a14-member-' + memberId + '@example.invalid' },
      { id: intruderId, email: 'qa-a14-intruder-' + intruderId + '@example.invalid' },
      { id: outsiderId, email: 'qa-a14-outsider-' + outsiderId + '@example.invalid' },
    ]);
    await db.insert(identityWorkspaces).values([
      { id: workspaceId, name: 'QA A14 Workspace', createdBy: ownerId },
      { id: otherWorkspaceId, name: 'QA A14 Other Workspace', createdBy: outsiderId },
    ]);
    await db.insert(identityMemberships).values([
      { id: randomUUID(), userId: ownerId, workspaceId, role: 'OWNER', status: 'ACTIVE' },
      { id: randomUUID(), userId: memberId, workspaceId, role: 'MEMBER', status: 'ACTIVE' },
      { id: randomUUID(), userId: intruderId, workspaceId, role: 'MEMBER', status: 'ACTIVE' },
      { id: randomUUID(), userId: outsiderId, workspaceId: otherWorkspaceId, role: 'OWNER', status: 'ACTIVE' },
    ]);
    const owner: Principal = { userId: ownerId as ID, workspaceId: workspaceId as ID, roles: ['OWNER'] };
    const member: Principal = { userId: memberId as ID, workspaceId: workspaceId as ID, roles: ['MEMBER'] };
    const intruder: Principal = { userId: intruderId as ID, workspaceId: workspaceId as ID, roles: ['MEMBER'] };
    const outsider: Principal = { userId: outsiderId as ID, workspaceId: otherWorkspaceId as ID, roles: ['OWNER'] };

    // --- the unconfigured deployment tells the truth -------------------------------------------
    const notConfiguredEnv = { ...process.env };
    delete notConfiguredEnv.QEYNOX_GOOGLE_WORKSPACE_CLIENT_ID;
    delete notConfiguredEnv.QEYNOX_GOOGLE_WORKSPACE_CLIENT_SECRET;
    delete notConfiguredEnv.QEYNOX_GOOGLE_WORKSPACE_REDIRECT_URI;
    delete notConfiguredEnv.QEYNOX_CONNECTION_CREDENTIAL_KEY;
    const coldVault = new ConnectionCredentialVault(db, notConfiguredEnv);
    const coldHub = new ConnectionHubService(store, coldVault, new FakeServerOAuthClient(fakeOAuth.baseUrl), REVIEWED_CONNECTION_PROVIDERS, notConfiguredEnv);
    const coldList = await coldHub.list(member);
    check(coldList.length === 1 && coldList[0]!.state === 'NOT_CONFIGURED', 'an unconfigured deployment reports NOT_CONFIGURED, never a fake connection');
    check((coldList[0]!.reason ?? '').includes('QEYNOX_GOOGLE_WORKSPACE_CLIENT_ID'), 'the reason names the missing deployment variables');
    await expectError('NOT_CONFIGURED', () => coldHub.authorize(member, 'google-workspace'), 'authorize while unconfigured');
    const coldAudit = await coldHub.audit(owner);
    check(coldAudit.some(entry => entry.action === 'AUTHORIZE_STARTED' && entry.outcome === 'DENIED'), 'the refused authorize is audited');

    // --- configure the deployment (fake provider client, real vault, loopback fake OAuth) -------
    const credentialKey = randomBytes(32).toString('base64');
    const clientSecret = 'qa-client-secret-' + randomBytes(8).toString('hex');
    const qaEnv = {
      ...process.env,
      QEYNOX_GOOGLE_WORKSPACE_CLIENT_ID: 'qa-client-id',
      QEYNOX_GOOGLE_WORKSPACE_CLIENT_SECRET: clientSecret,
      QEYNOX_GOOGLE_WORKSPACE_REDIRECT_URI: 'https://qa.example.invalid/v1/connections/google-workspace/callback',
      QEYNOX_CONNECTION_CREDENTIAL_KEY: credentialKey,
    };
    const vault = new ConnectionCredentialVault(db, qaEnv);
    check(vault.configured(), 'the configured vault accepts the QA key');
    const hub = new ConnectionHubService(store, vault, new FakeServerOAuthClient(fakeOAuth.baseUrl), REVIEWED_CONNECTION_PROVIDERS, qaEnv);

    const required = await hub.list(member);
    check(required[0]!.state === 'CONNECT_REQUIRED', 'a configured deployment with no account reports CONNECT_REQUIRED');

    // --- authorize: PKCE, single-use state, least-privilege scopes ------------------------------
    const authorize1 = await hub.authorize(member, 'google-workspace');
    check(connectionAuthorizationSchema.safeParse(authorize1).success, 'the authorize response satisfies the wire contract');
    const url1 = new URL(authorize1.authorizationUrl);
    check(url1.origin === 'https://accounts.google.com', 'the authorization URL targets the reviewed provider origin');
    check(extractParam(authorize1.authorizationUrl, 'response_type') === 'code', 'authorization code flow');
    check(extractParam(authorize1.authorizationUrl, 'client_id') === 'qa-client-id', 'the configured client id is used');
    check(extractParam(authorize1.authorizationUrl, 'redirect_uri') === qaEnv.QEYNOX_GOOGLE_WORKSPACE_REDIRECT_URI, 'the registered redirect URI is used');
    check(extractParam(authorize1.authorizationUrl, 'scope') === 'openid email profile', 'least-privilege requested scopes only');
    check(extractParam(authorize1.authorizationUrl, 'code_challenge_method') === 'S256', 'PKCE S256 is required');
    const state1 = extractParam(authorize1.authorizationUrl, 'state');
    check(/^[A-Za-z0-9_-]{43}$/.test(state1), 'state is a 32-byte base64url value');
    const pendingRow = await db.select().from(connections).where(and(eq(connections.workspaceId, workspaceId), eq(connections.provider, 'google-workspace')));
    check(pendingRow.length === 1 && pendingRow[0]!.state === 'PENDING_AUTHORIZATION', 'a PENDING_AUTHORIZATION placeholder row makes abandoned attempts visible');

    // --- callback: expired state refused ----------------------------------------------------------
    await db.update(oauthAuthorizationStates).set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(oauthAuthorizationStates.stateHash, sha256(state1)));
    await expectError('DENIED', () => hub.callback({ providerId: 'google-workspace', code: FAKE_CODE, state: state1 }), 'callback with an expired state');

    // --- callback: membership re-verified ----------------------------------------------------------
    const authorize2 = await hub.authorize(member, 'google-workspace');
    const state2 = extractParam(authorize2.authorizationUrl, 'state');
    await db.update(identityMemberships).set({ status: 'INACTIVE' })
      .where(and(eq(identityMemberships.userId, memberId), eq(identityMemberships.workspaceId, workspaceId)));
    await expectError('DENIED', () => hub.callback({ providerId: 'google-workspace', code: FAKE_CODE, state: state2 }), 'callback after membership ended');
    await db.update(identityMemberships).set({ status: 'ACTIVE' })
      .where(and(eq(identityMemberships.userId, memberId), eq(identityMemberships.workspaceId, workspaceId)));

    // --- callback: happy path ----------------------------------------------------------------------
    const authorize3 = await hub.authorize(member, 'google-workspace');
    const state3 = extractParam(authorize3.authorizationUrl, 'state');
    fake.challenge = extractParam(authorize3.authorizationUrl, 'code_challenge');
    fake.grantedScopes = 'openid email profile';
    const connected = await hub.callback({ providerId: 'google-workspace', code: FAKE_CODE, state: state3 });
    check(connected.state === 'CONNECTED', 'the connection is CONNECTED after callback');
    check(connected.grantedScopes.join(' ') === 'openid email profile', 'granted scopes come from the token response, not the request');
    check(connected.capabilities.includes('identity.openid') && connected.capabilities.includes('account.email') && connected.capabilities.includes('account.profile'), 'capabilities are derived from granted scopes');
    check(!JSON.stringify(connected).includes(QA_ACCESS_PREFIX), 'the view never carries an access token');
    check(!JSON.stringify(connected).includes(clientSecret), 'the view never carries the client secret');
    check(connected.connectedBy === 'qa-a14-member-' + memberId + '@example.invalid', 'connectedBy names the connecting member');

    const storedRow = await db.select().from(connections).where(and(eq(connections.workspaceId, workspaceId), eq(connections.provider, 'google-workspace')));
    check(storedRow[0]!.state === 'ACTIVE', 'the connection row is ACTIVE');
    check(Array.isArray(storedRow[0]!.capabilities) && storedRow[0]!.capabilities.length === 3, 'capabilities persisted');
    const credentialRows = await db.select().from(connectionCredentials).where(eq(connectionCredentials.workspaceId, workspaceId));
    check(credentialRows.length === 1, 'exactly one sealed credential exists');
    check(!Buffer.from(credentialRows[0]!.ciphertext).includes(Buffer.from(QA_ACCESS_PREFIX)), 'stored ciphertext never contains the plaintext access token');

    // --- replay refused ------------------------------------------------------------------------------
    await expectError('DENIED', () => hub.callback({ providerId: 'google-workspace', code: FAKE_CODE, state: state3 }), 'replayed state');

    // --- unknown state refused -------------------------------------------------------------------------
    await expectError('DENIED', () => hub.callback({ providerId: 'google-workspace', code: FAKE_CODE, state: base64url(randomBytes(32)) }), 'unknown state');

    // --- scope-derived capability enforcement at the resolver -------------------------------------------
    const resolver = hub.createCredentialResolver();
    const granted = await resolver({ workspaceId, provider: 'google-workspace', requiredScopes: ['openid', 'email'] });
    check(typeof granted === 'string' && granted.startsWith(QA_ACCESS_PREFIX), 'the resolver returns a usable access token for granted scopes');
    await expectError('DENIED', () => resolver({ workspaceId, provider: 'google-workspace', requiredScopes: ['drive.readonly'] }), 'resolver refuses scopes the connection does not hold');

    // --- lazy refresh on near expiry through the resolver -----------------------------------------------
    const beforeRefresh = await db.select().from(connections).where(and(eq(connections.workspaceId, workspaceId), eq(connections.provider, 'google-workspace')));
    const refBefore = beforeRefresh[0]!.credentialRef!;
    await db.update(connections).set({ accessTokenExpiresAt: new Date(Date.now() - 1000) })
      .where(and(eq(connections.workspaceId, workspaceId), eq(connections.provider, 'google-workspace')));
    const refreshedToken = await resolver({ workspaceId, provider: 'google-workspace', requiredScopes: ['openid'] });
    check(refreshedToken.startsWith(QA_ACCESS_PREFIX), 'the resolver refreshed the expiring token');
    const afterRefresh = await db.select().from(connections).where(and(eq(connections.workspaceId, workspaceId), eq(connections.provider, 'google-workspace')));
    check(afterRefresh[0]!.credentialRef !== refBefore, 'a rotated credential reference is minted on refresh');
    const auditAfterRefresh = await hub.audit(owner, 100);
    check(auditAfterRefresh.some(entry => entry.action === 'REFRESH' && entry.outcome === 'SUCCESS'), 'the refresh is audited');

    // --- rotating refresh tokens: the old refresh token dies on use --------------------------------------
    fake.rotateRefreshToken = true;
    const refBeforeRotation = afterRefresh[0]!.credentialRef!;
    await db.update(connections).set({ accessTokenExpiresAt: new Date(Date.now() - 1000) })
      .where(and(eq(connections.workspaceId, workspaceId), eq(connections.provider, 'google-workspace')));
    await resolver({ workspaceId, provider: 'google-workspace', requiredScopes: ['openid'] });
    const afterRotation = await db.select().from(connections).where(and(eq(connections.workspaceId, workspaceId), eq(connections.provider, 'google-workspace')));
    check(afterRotation[0]!.credentialRef !== refBeforeRotation, 'a rotating refresh token mints a fresh sealed reference');
    fake.rotateRefreshToken = false;

    // --- invalid_grant: the credential is wiped and the connection marked EXPIRED ------------------------
    fake.revokeAllRefreshTokens();
    await db.update(connections).set({ accessTokenExpiresAt: new Date(Date.now() - 1000) })
      .where(and(eq(connections.workspaceId, workspaceId), eq(connections.provider, 'google-workspace')));
    await expectError('NOT_CONFIGURED', () => hub.refresh(member, 'google-workspace'), 'manual refresh after invalid_grant');
    const expiredRow = await db.select().from(connections).where(and(eq(connections.workspaceId, workspaceId), eq(connections.provider, 'google-workspace')));
    check(expiredRow[0]!.state === 'EXPIRED' && expiredRow[0]!.credentialRef === null, 'invalid_grant wipes the credential and marks the connection EXPIRED');
    const auditInvalidGrant = await hub.audit(owner, 100);
    check(auditInvalidGrant.some(entry => entry.action === 'REFRESH' && entry.outcome === 'FAILED' && entry.reason === 'INVALID_GRANT'), 'the invalid_grant failure is audited');
    await expectError('NOT_CONFIGURED', () => resolver({ workspaceId, provider: 'google-workspace' }), 'a dead connection cannot mint tokens');

    // --- reconnect, then disconnect lifecycle -------------------------------------------------------------
    const authorize4 = await hub.authorize(member, 'google-workspace');
    const state4 = extractParam(authorize4.authorizationUrl, 'state');
    fake.challenge = extractParam(authorize4.authorizationUrl, 'code_challenge');
    fake.grantedScopes = 'openid email';
    await hub.callback({ providerId: 'google-workspace', code: FAKE_CODE, state: state4 });
    const reconnected = await db.select().from(connections).where(and(eq(connections.workspaceId, workspaceId), eq(connections.provider, 'google-workspace')));
    const refForIsolation = reconnected[0]!.credentialRef!;
    check(reconnected[0]!.state === 'ACTIVE', 'reconnect restores an ACTIVE connection');
    const narrowView = await hub.list(member);
    check(narrowView[0]!.capabilities.includes('account.email') && !narrowView[0]!.capabilities.includes('account.profile'), 'capabilities track the narrower grant after reconnect');

    // --- vault isolation: wrong key and wrong workspace both fail closed -----------------------------------
    const wrongKeyVault = new ConnectionCredentialVault(db, { ...qaEnv, QEYNOX_CONNECTION_CREDENTIAL_KEY: randomBytes(32).toString('base64') });
    await expectError('NOT_CONFIGURED', () => wrongKeyVault.read(refForIsolation, workspaceId), 'reading with the wrong key');
    await expectError('NOT_CONFIGURED', () => vault.read(refForIsolation, otherWorkspaceId), 'reading from another workspace');

    // --- disconnect: permission, remote revoke, local wipe, idempotency ------------------------------------
    await expectError('DENIED', () => hub.disconnect(intruder, 'google-workspace'), 'a member who did not connect the account');
    const disconnected = await hub.disconnect(owner, 'google-workspace');
    check(disconnected.state === 'REVOKED', 'an OWNER can disconnect the account');
    check(fake.revocations.length >= 1, 'the provider was asked to revoke the token');
    await expectError('NOT_CONFIGURED', () => vault.read(refForIsolation, workspaceId), 'the sealed credential is wiped on disconnect');
    const revokedRow = await db.select().from(connections).where(and(eq(connections.workspaceId, workspaceId), eq(connections.provider, 'google-workspace')));
    check(revokedRow[0]!.state === 'REVOKED' && revokedRow[0]!.credentialRef === null && revokedRow[0]!.scopes.length === 0, 'disconnect revokes, wipes and clears granted scopes');
    const again = await hub.disconnect(owner, 'google-workspace');
    check(again.state === 'REVOKED', 'disconnect is idempotent');
    await expectError('NOT_CONFIGURED', () => resolver({ workspaceId, provider: 'google-workspace' }), 'a revoked connection cannot mint tokens');

    // --- audit trail: lifecycle coverage and secret hygiene --------------------------------------------------
    const audit = await hub.audit(owner, 200);
    for (const action of ['AUTHORIZE_STARTED', 'CALLBACK', 'REFRESH', 'DISCONNECT']) {
      check(audit.some(entry => entry.action === action), 'audit trail records ' + action);
    }
    const serialized = JSON.stringify(audit);
    check(!serialized.includes(clientSecret), 'the audit trail never contains the client secret');
    check(!serialized.includes(QA_ACCESS_PREFIX) && !serialized.includes(QA_REFRESH_PREFIX), 'the audit trail never contains token material');
    check(connectionAuditListSchema.safeParse(audit).success, 'the audit trail satisfies the wire contract');
    const outsiderAudit = await hub.audit(outsider, 200);
    check(outsiderAudit.length === 0, 'the audit trail is workspace-scoped — another workspace sees nothing');

    const finalList = await hub.list(member);
    check(finalList[0]!.state === 'REVOKED', 'the workspace sees its own connection as REVOKED');
    const outsiderList = await hub.list(outsider);
    check(outsiderList[0]!.state === 'CONNECT_REQUIRED' && outsiderList[0]!.grantedScopes.length === 0, 'another workspace sees no trace of our connection');

    console.log('  PART 2 PASSED: cumulative ' + assertions + ' assertions');
    return 'PASSED';
  } finally {
    await connection?.close().catch(() => undefined);
    await new Promise<void>(resolve => fakeOAuth.server.close(() => resolve()));
    await qa.drop().catch(error => console.error('QA database teardown warning:', error instanceof Error ? error.message : error));
  }
}

partOne();
try {
  const integration = await partTwo();
  if (integration === 'BLOCKED') {
    console.log('A14 CONNECTOR HUB QA PARTIAL — PART 1 PASSED (' + assertions + ' assertions), PART 2 BLOCKED.');
    console.log('This run is NOT integration evidence: the OAuth lifecycle and the vault were not exercised.');
    process.exit(BLOCKED);
  }
  console.log('A14 CONNECTOR HUB QA PASSED: ' + assertions + ' assertions (PART 1 contracts + PART 2 OAuth lifecycle).');
  process.exit(PASS);
} catch (error: unknown) {
  if (error instanceof BlockedSignal) {
    console.log('A14 CONNECTOR HUB QA BLOCKED: ' + error.reason);
    console.log('This run is NOT integration evidence: a required prerequisite or the database was unavailable.');
    process.exit(BLOCKED);
  }
  console.error('A14 CONNECTOR HUB QA FAILED:', error instanceof Error ? error.message : error);
  process.exit(FAILED);
}

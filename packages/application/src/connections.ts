import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DomainError, type Principal } from '@qeynox/domain';
import { and, desc, eq } from 'drizzle-orm';
import {
  connectionAuditEvents, connections, identityMemberships, identityUsers, oauthAuthorizationStates,
  type QeyNoxStore,
} from '@qeynox/persistence';
import type { ConnectionProviderState, ConnectionView } from '@qeynox/contracts';
import {
  REVIEWED_CONNECTION_PROVIDERS, providerAvailability, providerClientCredentials,
  type ReviewedConnectionProvider,
} from './connection-providers';
import { ConnectionCredentialVault, type ConnectionMaterial } from './connection-vault';

/**
 * MISSION A14 — the connector hub.
 *
 * Workspace-scoped account connections on top of the reviewed provider declarations and the
 * server-side credential vault. The hub:
 *
 * - starts OAuth authorizations (PKCE + single-use, hashed state) — never a raw token flows through
 *   the browser; the provider redirects back to the API callback with a code;
 * - completes the callback: re-checks membership, consumes the state exactly once, exchanges the
 *   code server-side and stores the material sealed in the vault;
 * - refreshes access tokens (rotating refresh tokens when the provider rotates) before expiry;
 * - revokes remotely (best effort) and always wipes locally;
 * - discovers capabilities from the actually granted scopes — never from what was asked for;
 * - records an audit row for every action, success or failure, with outcome and reason only.
 *
 * Credentials never appear in views, logs, prompts or error messages. Unconfigured providers and a
 * missing credential key are reported truthfully; nothing falls back to a fake provider.
 */

export interface OAuthHttpClient {
  /** POST the authorization_code exchange. Throws DomainError on any provider/transport failure. */
  authorizationCode(provider: ReviewedConnectionProvider, input: { code: string; codeVerifier: string; clientId: string; clientSecret: string; redirectUri: string }): Promise<Record<string, unknown>>;
  /** POST the refresh_token exchange. Throws DomainError on failure. */
  refreshToken(provider: ReviewedConnectionProvider, input: { refreshToken: string; clientId: string; clientSecret: string }): Promise<Record<string, unknown>>;
  /** Best-effort revocation. Throws on failure; callers decide whether to swallow. */
  revoke(provider: ReviewedConnectionProvider, input: { token: string; clientId: string; clientSecret: string }): Promise<void>;
}

const SCOPE_SEPARATOR = ' ';
const STATE_TTL_MS = 10 * 60 * 1000;
const REFRESH_SKEW_MS = 2 * 60 * 1000;
const EXPIRING_WINDOW_MS = 10 * 60 * 1000;

/** Strict HTTPS transport for real providers. Non-HTTPS hosts are refused outside of injected QA clients. */
export class HttpOAuthClient implements OAuthHttpClient {
  constructor(private readonly fetchImpl: typeof fetch = fetch, private readonly timeoutMs = 15_000) {}
  private assertReviewedEndpoint(url: string): URL {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') throw new DomainError('NOT_CONFIGURED', 'Provider endpoint is not HTTPS: ' + parsed.origin);
    if (parsed.username || parsed.password) throw new DomainError('DENIED', 'Provider endpoint must not embed credentials');
    return parsed;
  }
  private async postForm(url: string, form: URLSearchParams): Promise<Record<string, unknown>> {
    const endpoint = this.assertReviewedEndpoint(url);
    const response = await this.fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: form.toString(),
      redirect: 'error',
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    let body: Record<string, unknown> = {};
    try { body = (await response.json()) as Record<string, unknown>; } catch { body = {}; }
    if (!response.ok) {
      const code = typeof body.error === 'string' ? body.error : 'PROVIDER_HTTP_' + response.status;
      throw new DomainError('UNAVAILABLE', 'Provider refused the OAuth call: ' + code.slice(0, 64), { providerError: code.slice(0, 64) });
    }
    if (typeof body.error === 'string') throw new DomainError('UNAVAILABLE', 'Provider refused the OAuth call: ' + body.error.slice(0, 64), { providerError: body.error.slice(0, 64) });
    return body;
  }
  authorizationCode(provider: ReviewedConnectionProvider, input: { code: string; codeVerifier: string; clientId: string; clientSecret: string; redirectUri: string }): Promise<Record<string, unknown>> {
    return this.postForm(provider.tokenUrl, new URLSearchParams({
      grant_type: 'authorization_code',
      code: input.code,
      code_verifier: input.codeVerifier,
      client_id: input.clientId,
      client_secret: input.clientSecret,
      redirect_uri: input.redirectUri,
    }));
  }
  refreshToken(provider: ReviewedConnectionProvider, input: { refreshToken: string; clientId: string; clientSecret: string }): Promise<Record<string, unknown>> {
    return this.postForm(provider.tokenUrl, new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: input.refreshToken,
      client_id: input.clientId,
      client_secret: input.clientSecret,
    }));
  }
  async revoke(provider: ReviewedConnectionProvider, input: { token: string; clientId: string; clientSecret: string }): Promise<void> {
    if (!provider.revokeUrl) return;
    const endpoint = this.assertReviewedEndpoint(provider.revokeUrl);
    const response = await this.fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ token: input.token, client_id: input.clientId, client_secret: input.clientSecret }).toString(),
      redirect: 'error',
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new DomainError('UNAVAILABLE', 'Provider refused the revocation call: HTTP ' + response.status);
  }
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
const base64url = (buffer: Buffer): string => buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function parseScopes(raw: unknown, fallback: readonly string[]): string[] {
  if (typeof raw !== 'string' || !raw.trim()) return [...fallback];
  return [...new Set(raw.split(SCOPE_SEPARATOR).map(part => part.trim()).filter(Boolean))];
}
function capabilitiesFromScopes(provider: ReviewedConnectionProvider, scopes: readonly string[]): string[] {
  return [...new Set(scopes.map(scope => provider.scopeCapabilities[scope]).filter((capability): capability is string => Boolean(capability)))];
}
function tokenExpiry(raw: unknown): Date | null {
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(Date.now() + seconds * 1000);
}
function toIso(date: Date | null | undefined): string | null {
  if (!date || Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}
function stateFromRow(now: Date, row: { state: string; accessTokenExpiresAt: Date | null; lastErrorCode: string | null }): ConnectionProviderState {
  if (row.state === 'REVOKED') return 'REVOKED';
  if (row.state === 'ERROR') return 'ERROR';
  if (row.state === 'PENDING_AUTHORIZATION') return 'CONNECT_REQUIRED';
  if (row.accessTokenExpiresAt) {
    if (now.getTime() >= row.accessTokenExpiresAt.getTime()) return 'EXPIRED';
    if (now.getTime() >= row.accessTokenExpiresAt.getTime() - EXPIRING_WINDOW_MS) return 'EXPIRING_SOON';
  }
  return 'CONNECTED';
}

export class ConnectionHubService {
  constructor(
    private readonly store: QeyNoxStore,
    private readonly vault: ConnectionCredentialVault = new ConnectionCredentialVault(store.db),
    private readonly oauth: OAuthHttpClient = new HttpOAuthClient(),
    private readonly providers: readonly ReviewedConnectionProvider[] = REVIEWED_CONNECTION_PROVIDERS,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  private provider(providerId: string): ReviewedConnectionProvider {
    const provider = this.providers.find(candidate => candidate.id === providerId);
    if (!provider) throw new DomainError('NOT_FOUND', 'Provider not found');
    return provider;
  }

  private async recordAudit(workspaceId: string, connectionId: string | null, userId: string | null, action: string, outcome: 'SUCCESS' | 'DENIED' | 'FAILED', reason: string | null, detail: Record<string, unknown> = {}): Promise<void> {
    try {
      await this.store.db.insert(connectionAuditEvents).values({
        id: randomUUID(), workspaceId, connectionId, userId, action, outcome, reason, detail, createdAt: new Date(),
      });
    } catch {
      // Audit is best-effort at the write site; the outcome of the operation itself is authoritative.
    }
  }

  /** Workspace-scoped connection views. Never includes credentials. */
  async list(actor: Principal): Promise<ConnectionView[]> {
    const now = new Date();
    const rows = await this.store.db.select().from(connections).where(eq(connections.workspaceId, actor.workspaceId));
    const byProvider = new Map(rows.map(row => [row.provider, row]));
    const views: ConnectionView[] = [];
    for (const provider of this.providers) {
      const row = byProvider.get(provider.id);
      const availability = providerAvailability(provider, this.env);
      const base = {
        provider: provider.id,
        providerVersion: provider.version,
        label: provider.label,
        purpose: provider.purpose,
        requestedScopes: [...provider.requestedScopes],
      };
      if (!availability.clientConfigured || !availability.redirectConfigured) {
        views.push({
          ...base,
          state: 'NOT_CONFIGURED',
          reason: 'The deployment is missing: ' + availability.missing.join(', '),
          grantedScopes: [], capabilities: [], externalAccountId: null,
          accessTokenExpiresAt: null, lastHealthCheckAt: null, connectedBy: null, connectedAt: null, lastErrorCode: null,
        });
        continue;
      }
      if (!this.vault.configured()) {
        views.push({
          ...base,
          state: 'NOT_CONFIGURED',
          reason: 'The deployment has no connection credential key (QEYNOX_CONNECTION_CREDENTIAL_KEY).',
          grantedScopes: [], capabilities: [], externalAccountId: null,
          accessTokenExpiresAt: null, lastHealthCheckAt: null, connectedBy: null, connectedAt: null, lastErrorCode: null,
        });
        continue;
      }
      if (!row) {
        views.push({
          ...base,
          state: 'CONNECT_REQUIRED',
          reason: null,
          grantedScopes: [], capabilities: [], externalAccountId: null,
          accessTokenExpiresAt: null, lastHealthCheckAt: null, connectedBy: null, connectedAt: null, lastErrorCode: null,
        });
        continue;
      }
      const state = stateFromRow(now, row);
      views.push({
        ...base,
        state,
        reason: state === 'CONNECT_REQUIRED' && row.state === 'PENDING_AUTHORIZATION' ? 'Authorization started but the provider has not redirected back yet.' : null,
        grantedScopes: [...row.scopes],
        capabilities: [...row.capabilities],
        externalAccountId: row.externalAccountId,
        accessTokenExpiresAt: toIso(row.accessTokenExpiresAt),
        lastHealthCheckAt: toIso(row.lastHealthCheckAt),
        connectedBy: row.connectedByEmail ?? row.connectedBy,
        connectedAt: toIso(row.createdAt),
        lastErrorCode: row.lastErrorCode,
      });
    }
    return views.sort((a, b) => a.provider.localeCompare(b.provider));
  }

  /** Audit trail for the workspace; latest entries first. Never carries credential material. */
  async audit(actor: Principal, limit = 50): Promise<{ id: string; connectionId: string | null; userId: string | null; action: string; outcome: 'SUCCESS' | 'DENIED' | 'FAILED'; reason: string | null; happenedAt: string }[]> {
    const rows = await this.store.db.select().from(connectionAuditEvents)
      .where(eq(connectionAuditEvents.workspaceId, actor.workspaceId))
      .orderBy(desc(connectionAuditEvents.createdAt))
      .limit(Math.min(200, Math.max(1, limit)));
    return rows.map(row => ({ id: row.id, connectionId: row.connectionId, userId: row.userId, action: row.action, outcome: row.outcome, reason: row.reason, happenedAt: row.createdAt.toISOString() }));
  }

  /** Step 1 of the OAuth dance. Returns the provider authorization URL; nothing is granted yet. */
  async authorize(actor: Principal, providerId: string): Promise<{ provider: string; authorizationUrl: string; expiresAt: string }> {
    const provider = this.provider(providerId);
    const availability = providerAvailability(provider, this.env);
    if (!availability.clientConfigured || !availability.redirectConfigured) {
      await this.recordAudit(actor.workspaceId, null, actor.userId, 'AUTHORIZE_STARTED', 'DENIED', 'PROVIDER_NOT_CONFIGURED', { missing: availability.missing });
      throw new DomainError('NOT_CONFIGURED', 'This provider is not configured on this deployment: ' + availability.missing.join(', '));
    }
    const credentials = providerClientCredentials(provider, this.env);
    if (!credentials) {
      await this.recordAudit(actor.workspaceId, null, actor.userId, 'AUTHORIZE_STARTED', 'DENIED', 'REDIRECT_URI_NOT_REGISTERED', {});
      throw new DomainError('NOT_CONFIGURED', 'The registered redirect URI is not a valid HTTPS URL');
    }
    if (!this.vault.configured()) {
      await this.recordAudit(actor.workspaceId, null, actor.userId, 'AUTHORIZE_STARTED', 'DENIED', 'CREDENTIAL_KEY_NOT_CONFIGURED', {});
      throw new DomainError('NOT_CONFIGURED', 'Connection credentials cannot be stored on this deployment');
    }

    const state = base64url(randomBytes(32));
    const codeVerifier = base64url(randomBytes(48));
    const codeChallenge = base64url(createHash('sha256').update(codeVerifier).digest());
    const now = new Date();
    const expiresAt = new Date(now.getTime() + STATE_TTL_MS);
    await this.store.db.insert(oauthAuthorizationStates).values({
      id: randomUUID(), stateHash: sha256(state), workspaceId: actor.workspaceId, userId: actor.userId,
      provider: provider.id, codeVerifier, redirectUri: credentials.redirectUri,
      state: 'PENDING', expiresAt, createdAt: now,
    });
    // A placeholder PENDING row makes "authorization started but abandoned" visible and auditable.
    await this.store.db.insert(connections).values({
      id: randomUUID(), workspaceId: actor.workspaceId, provider: provider.id, providerVersion: provider.version,
      state: 'PENDING_AUTHORIZATION', scopes: [], capabilities: [], credentialRef: null,
      accessTokenExpiresAt: null, refreshTokenExpiresAt: null, externalAccountId: null,
      lastErrorCode: null, lastHealthCheckAt: now, connectedBy: actor.userId, connectedByEmail: await this.emailOf(actor.userId),
      createdAt: now, updatedAt: now,
    }).onConflictDoUpdate({
      target: [connections.workspaceId, connections.provider],
      set: { state: 'PENDING_AUTHORIZATION', updatedAt: now, connectedBy: actor.userId, connectedByEmail: await this.emailOf(actor.userId), lastErrorCode: null },
    });
    await this.recordAudit(actor.workspaceId, null, actor.userId, 'AUTHORIZE_STARTED', 'SUCCESS', null, { provider: provider.id });

    const url = new URL(provider.authorizationUrl);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', credentials.clientId);
    url.searchParams.set('redirect_uri', credentials.redirectUri);
    url.searchParams.set('scope', provider.requestedScopes.join(SCOPE_SEPARATOR));
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return { provider: provider.id, authorizationUrl: url.toString(), expiresAt: expiresAt.toISOString() };
  }

  private async emailOf(userId: string): Promise<string | null> {
    const [row] = await this.store.db.select().from(identityUsers).where(eq(identityUsers.id, userId)).limit(1);
    return row?.email ?? null;
  }

  /**
   * Step 2 of the OAuth dance. No principal: the state hash authenticates the round-trip. Membership
   * is re-verified before the code is exchanged. The state is single-use under a row lock race.
   */
  async callback(input: { providerId: string; code: string; state: string }): Promise<ConnectionView> {
    const provider = this.provider(input.providerId);
    const stateHash = sha256(input.state);
    const [row] = await this.store.db.select().from(oauthAuthorizationStates).where(eq(oauthAuthorizationStates.stateHash, stateHash)).limit(1);
    if (!row || row.provider !== provider.id) {
      // A wholly unknown state cannot be attributed to a workspace; there is nothing safe to write.
      throw new DomainError('DENIED', 'The connection authorization is not recognized');
    }
    if (row.state !== 'PENDING') {
      await this.recordAudit(row.workspaceId, null, row.userId, 'CALLBACK', 'DENIED', 'STATE_REPLAYED', { provider: provider.id });
      throw new DomainError('DENIED', 'The connection authorization was already used');
    }
    if (Date.now() > row.expiresAt.getTime()) {
      await this.recordAudit(row.workspaceId, null, row.userId, 'CALLBACK', 'DENIED', 'STATE_EXPIRED', { provider: provider.id });
      throw new DomainError('DENIED', 'The connection authorization expired — start again');
    }
    // Membership is re-verified at callback time: authorize must not outlive membership.
    const [membership] = await this.store.db.select().from(identityMemberships)
      .where(and(eq(identityMemberships.workspaceId, row.workspaceId), eq(identityMemberships.userId, row.userId), eq(identityMemberships.status, 'ACTIVE'))).limit(1);
    if (!membership) {
      await this.recordAudit(row.workspaceId, null, row.userId, 'CALLBACK', 'DENIED', 'MEMBERSHIP_NOT_ACTIVE', { provider: provider.id });
      throw new DomainError('DENIED', 'Membership is no longer active in this workspace');
    }
    // Single-use: flip to CONSUMED atomically; a concurrent callback loses the race.
    const updated = await this.store.db.update(oauthAuthorizationStates)
      .set({ state: 'CONSUMED', consumedAt: new Date() })
      .where(and(eq(oauthAuthorizationStates.id, row.id), eq(oauthAuthorizationStates.state, 'PENDING')))
      .returning({ id: oauthAuthorizationStates.id });
    if (updated.length === 0) {
      await this.recordAudit(row.workspaceId, null, row.userId, 'CALLBACK', 'DENIED', 'STATE_REPLAYED', { provider: provider.id });
      throw new DomainError('DENIED', 'The connection authorization was already used');
    }

    const credentials = providerClientCredentials(provider, this.env);
    if (!credentials) {
      await this.failConnection(row.workspaceId, provider.id, row.userId, null, 'PROVIDER_NOT_CONFIGURED');
      throw new DomainError('NOT_CONFIGURED', 'Provider credentials disappeared after authorization started');
    }
    let tokens: Record<string, unknown>;
    try {
      tokens = await this.oauth.authorizationCode(provider, { code: input.code, codeVerifier: row.codeVerifier, clientId: credentials.clientId, clientSecret: credentials.clientSecret, redirectUri: row.redirectUri });
    } catch (error: unknown) {
      const code = error instanceof DomainError ? error.code : 'TOKEN_EXCHANGE_FAILED';
      await this.failConnection(row.workspaceId, provider.id, row.userId, null, code);
      throw new DomainError('UNAVAILABLE', 'The provider refused the authorization code. Start the connection again.');
    }
    const accessToken = typeof tokens.access_token === 'string' ? tokens.access_token : '';
    if (!accessToken) {
      await this.failConnection(row.workspaceId, provider.id, row.userId, null, 'TOKEN_RESPONSE_INVALID');
      throw new DomainError('UNAVAILABLE', 'The provider returned no access token. Start the connection again.');
    }
    const grantedScopes = parseScopes(tokens.scope, provider.requestedScopes);
    const capabilities = capabilitiesFromScopes(provider, grantedScopes);
    const material: ConnectionMaterial = {
      accessToken,
      refreshToken: typeof tokens.refresh_token === 'string' ? tokens.refresh_token : null,
      tokenType: typeof tokens.token_type === 'string' && tokens.token_type ? tokens.token_type : 'Bearer',
      expiresAt: toIso(tokenExpiry(tokens.expires_in)),
      refreshExpiresAt: null,
    };
    const [previous] = await this.store.db.select().from(connections)
      .where(and(eq(connections.workspaceId, row.workspaceId), eq(connections.provider, provider.id))).limit(1);
    const ref = await this.vault.store(row.workspaceId, provider.id, material);
    const oldRef = previous?.credentialRef ?? null;
    const now = new Date();
    await this.store.db.update(connections).set({
      state: 'ACTIVE',
      scopes: grantedScopes,
      capabilities,
      credentialRef: ref,
      accessTokenExpiresAt: tokenExpiry(tokens.expires_in),
      refreshTokenExpiresAt: null,
      lastErrorCode: null,
      lastHealthCheckAt: now,
      connectedBy: row.userId,
      connectedByEmail: await this.emailOf(row.userId),
      updatedAt: now,
    }).where(and(eq(connections.workspaceId, row.workspaceId), eq(connections.provider, provider.id)));
    if (oldRef) await this.vault.wipe(oldRef, row.workspaceId);
    await this.recordAudit(row.workspaceId, previous?.id ?? null, row.userId, 'CALLBACK', 'SUCCESS', null, { provider: provider.id, grantedScopes, capabilities });
    const [connectionRow] = await this.store.db.select().from(connections)
      .where(and(eq(connections.workspaceId, row.workspaceId), eq(connections.provider, provider.id))).limit(1);
    return this.viewOf(provider, connectionRow!, row.userId);
  }

  private async failConnection(workspaceId: string, providerId: string, userId: string, connectionId: string | null, code: string): Promise<void> {
    const now = new Date();
    await this.store.db.update(connections).set({ state: 'ERROR', lastErrorCode: code, lastHealthCheckAt: now, updatedAt: now })
      .where(and(eq(connections.workspaceId, workspaceId), eq(connections.provider, providerId)));
    await this.recordAudit(workspaceId, connectionId, userId, 'CALLBACK', 'FAILED', code, { provider: providerId });
  }

  private viewOf(provider: ReviewedConnectionProvider, row: typeof connections.$inferSelect, actorUserId: string): ConnectionView {
    const now = new Date();
    const state = stateFromRow(now, row);
    return {
      provider: provider.id, providerVersion: provider.version, label: provider.label, purpose: provider.purpose,
      state,
      reason: state === 'ERROR' && row.lastErrorCode ? 'The provider reported an error: ' + row.lastErrorCode : null,
      requestedScopes: [...provider.requestedScopes],
      grantedScopes: [...row.scopes],
      capabilities: [...row.capabilities],
      externalAccountId: row.externalAccountId,
      accessTokenExpiresAt: toIso(row.accessTokenExpiresAt),
      lastHealthCheckAt: toIso(row.lastHealthCheckAt),
      connectedBy: row.connectedByEmail ?? actorUserId,
      connectedAt: toIso(row.createdAt),
      lastErrorCode: row.lastErrorCode,
    };
  }

  /** Manual repair: refresh the access token now (also happens lazily before provider calls). */
  async refresh(actor: Principal, providerId: string): Promise<ConnectionView> {
    const provider = this.provider(providerId);
    const [row] = await this.store.db.select().from(connections).where(and(eq(connections.workspaceId, actor.workspaceId), eq(connections.provider, provider.id))).limit(1);
    if (!row) throw new DomainError('NOT_FOUND', 'Connection not found');
    await this.assertCanMutate(actor, row);
    if (row.state === 'REVOKED') throw new DomainError('INVALID_STATE', 'The connection is revoked — connect again');
    const material = await this.readMaterial(actor, row);
    if (!material.refreshToken) throw new DomainError('INVALID_STATE', 'The provider issued no refresh token — connect again');
    const result = await this.refreshWithMaterial(provider, actor, row, material);
    return result;
  }

  /**
   * Revocation lifecycle: best-effort remote revoke, then unconditional local wipe. Idempotent —
   * disconnecting an already-revoked connection is a safe no-op. Permission: workspace OWNER/ADMIN
   * or the member who connected the account.
   */
  async disconnect(actor: Principal, providerId: string): Promise<{ state: ConnectionProviderState }> {
    const provider = this.provider(providerId);
    const [row] = await this.store.db.select().from(connections).where(and(eq(connections.workspaceId, actor.workspaceId), eq(connections.provider, provider.id))).limit(1);
    if (!row) throw new DomainError('NOT_FOUND', 'Connection not found');
    if (row.state === 'REVOKED') {
      await this.recordAudit(actor.workspaceId, row.id, actor.userId, 'DISCONNECT', 'SUCCESS', 'ALREADY_REVOKED', { provider: provider.id });
      return { state: 'REVOKED' };
    }
    await this.assertCanMutate(actor, row);
    const credentials = providerClientCredentials(provider, this.env);
    let remoteError: string | null = null;
    if (credentials && row.credentialRef) {
      try {
        const material = await this.vault.read(row.credentialRef, actor.workspaceId);
        const token = material.refreshToken ?? material.accessToken;
        await this.oauth.revoke(provider, { token, clientId: credentials.clientId, clientSecret: credentials.clientSecret });
      } catch (error: unknown) {
        remoteError = error instanceof DomainError ? error.code : 'REMOTE_REVOKE_FAILED';
      }
    }
    if (row.credentialRef) await this.vault.wipe(row.credentialRef, actor.workspaceId);
    const now = new Date();
    await this.store.db.update(connections).set({
      state: 'REVOKED', credentialRef: null, scopes: [], capabilities: [], accessTokenExpiresAt: null, refreshTokenExpiresAt: null,
      lastErrorCode: null, lastHealthCheckAt: now, updatedAt: now,
    }).where(and(eq(connections.workspaceId, actor.workspaceId), eq(connections.provider, provider.id)));
    await this.recordAudit(actor.workspaceId, row.id, actor.userId, 'DISCONNECT', remoteError ? 'FAILED' : 'SUCCESS', remoteError, { provider: provider.id, remoteRevoked: remoteError === null });
    return { state: 'REVOKED' };
  }

  /** Resolver handed to reviewed adapters; they ask for exactly the scopes their tools require. */
  createCredentialResolver() {
    return async (input: { workspaceId: string; provider: string; requiredScopes?: readonly string[] }): Promise<string> => {
      const [row] = await this.store.db.select().from(connections)
        .where(and(eq(connections.workspaceId, input.workspaceId), eq(connections.provider, input.provider))).limit(1);
      if (!row || row.state === 'REVOKED' || row.state === 'ERROR') {
        throw new DomainError('NOT_CONFIGURED', 'The workspace has no usable connection for this provider');
      }
      if (row.credentialRef === null) throw new DomainError('NOT_CONFIGURED', 'The connection holds no credential material');
      const required = input.requiredScopes ?? [];
      const missing = required.filter(scope => !row.scopes.includes(scope));
      if (missing.length > 0) {
        throw new DomainError('DENIED', 'The connection lacks the required scopes: ' + missing.join(', '));
      }
      let credentialRef: string | null = row.credentialRef;
      if (row.accessTokenExpiresAt && row.accessTokenExpiresAt.getTime() - Date.now() < REFRESH_SKEW_MS) {
        const refreshed = await this.refreshLocked(input.workspaceId, row);
        if (!refreshed) {
          throw new DomainError('NOT_CONFIGURED', 'The connection token could not be refreshed — reconnect the account');
        }
        const [fresh] = await this.store.db.select().from(connections)
          .where(and(eq(connections.workspaceId, input.workspaceId), eq(connections.provider, input.provider))).limit(1);
        credentialRef = fresh?.credentialRef ?? null;
      }
      if (!credentialRef) throw new DomainError('NOT_CONFIGURED', 'The connection holds no usable credential — reconnect the account');
      const material = await this.vault.read(credentialRef, input.workspaceId);
      return material.accessToken;
    };
  }

  private async refreshLocked(workspaceId: string, row: typeof connections.$inferSelect): Promise<boolean> {
    try {
      const provider = this.provider(row.provider);
      const material = await this.vault.read(row.credentialRef ?? '', workspaceId);
      if (!material.refreshToken) return false;
      const actor: Principal = { userId: row.connectedBy as Principal['userId'], workspaceId: workspaceId as Principal['workspaceId'], roles: [] };
      await this.refreshWithMaterial(provider, actor, row, material, workspaceId);
      return true;
    } catch {
      return false;
    }
  }

  private async refreshWithMaterial(provider: ReviewedConnectionProvider, actor: Principal, row: typeof connections.$inferSelect, material: ConnectionMaterial, workspaceScope?: string): Promise<ConnectionView> {
    const scopeWorkspaceId = workspaceScope ?? actor.workspaceId;
    const credentials = providerClientCredentials(provider, this.env);
    if (!credentials) throw new DomainError('NOT_CONFIGURED', 'This provider is not configured on this deployment');
    let tokens: Record<string, unknown>;
    try {
      tokens = await this.oauth.refreshToken(provider, { refreshToken: material.refreshToken ?? '', clientId: credentials.clientId, clientSecret: credentials.clientSecret });
    } catch (error: unknown) {
      const code = error instanceof DomainError ? (error.context?.providerError ?? error.code) : 'REFRESH_FAILED';
      if (code === 'invalid_grant') {
        // Dead refresh token: the credential is worthless either way. Wipe it and mark EXPIRED.
        if (row.credentialRef) await this.vault.wipe(row.credentialRef, scopeWorkspaceId);
        const now = new Date();
        await this.store.db.update(connections).set({ state: 'EXPIRED', credentialRef: null, lastErrorCode: 'INVALID_GRANT', lastHealthCheckAt: now, updatedAt: now })
          .where(and(eq(connections.workspaceId, scopeWorkspaceId), eq(connections.provider, provider.id)));
        await this.recordAudit(scopeWorkspaceId, row.id, actor.userId, 'REFRESH', 'FAILED', 'INVALID_GRANT', { provider: provider.id });
        throw new DomainError('NOT_CONFIGURED', 'The connection expired — reconnect the account');
      }
      await this.recordAudit(scopeWorkspaceId, row.id, actor.userId, 'REFRESH', 'FAILED', code, { provider: provider.id });
      throw new DomainError('UNAVAILABLE', 'The provider refused the token refresh');
    }
    const accessToken = typeof tokens.access_token === 'string' ? tokens.access_token : '';
    if (!accessToken) {
      await this.recordAudit(scopeWorkspaceId, row.id, actor.userId, 'REFRESH', 'FAILED', 'TOKEN_RESPONSE_INVALID', { provider: provider.id });
      throw new DomainError('UNAVAILABLE', 'The provider returned no access token');
    }
    const grantedScopes = parseScopes(tokens.scope, row.scopes);
    const capabilities = capabilitiesFromScopes(provider, grantedScopes);
    const next: ConnectionMaterial = {
      accessToken,
      // Rotating refresh tokens: keep the old one only when the provider did not rotate.
      refreshToken: typeof tokens.refresh_token === 'string' && tokens.refresh_token ? tokens.refresh_token : material.refreshToken,
      tokenType: typeof tokens.token_type === 'string' && tokens.token_type ? tokens.token_type : material.tokenType,
      expiresAt: toIso(tokenExpiry(tokens.expires_in)),
      refreshExpiresAt: material.refreshExpiresAt,
    };
    const ref = await this.vault.store(scopeWorkspaceId, provider.id, next);
    if (row.credentialRef) await this.vault.wipe(row.credentialRef, scopeWorkspaceId);
    const now = new Date();
    await this.store.db.update(connections).set({
      state: 'ACTIVE', scopes: grantedScopes, capabilities, credentialRef: ref,
      accessTokenExpiresAt: tokenExpiry(tokens.expires_in),
      lastErrorCode: null, lastHealthCheckAt: now, updatedAt: now,
    }).where(and(eq(connections.workspaceId, scopeWorkspaceId), eq(connections.provider, provider.id)));
    await this.recordAudit(scopeWorkspaceId, row.id, actor.userId, 'REFRESH', 'SUCCESS', null, { provider: provider.id, rotatedRefreshToken: typeof tokens.refresh_token === 'string' && Boolean(tokens.refresh_token) });
    const [connectionRow] = await this.store.db.select().from(connections)
      .where(and(eq(connections.workspaceId, scopeWorkspaceId), eq(connections.provider, provider.id))).limit(1);
    return this.viewOf(provider, connectionRow!, actor.userId);
  }

  private async readMaterial(actor: Principal, row: typeof connections.$inferSelect): Promise<ConnectionMaterial> {
    if (!row.credentialRef) throw new DomainError('INVALID_STATE', 'The connection holds no credential material — reconnect');
    return this.vault.read(row.credentialRef, actor.workspaceId);
  }

  private async assertCanMutate(actor: Principal, row: typeof connections.$inferSelect): Promise<void> {
    const roles = actor.roles ?? [];
    const elevated = roles.includes('OWNER') || roles.includes('ADMIN');
    if (!elevated && row.connectedBy !== actor.userId) {
      await this.recordAudit(actor.workspaceId, row.id, actor.userId, 'MUTATION', 'DENIED', 'NOT_OWNER_OF_CONNECTION', { provider: row.provider });
      throw new DomainError('DENIED', 'Only the member who connected the account (or a workspace OWNER/ADMIN) can manage it');
    }
  }
}

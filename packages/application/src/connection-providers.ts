/**
 * MISSION A14 — reviewed connection provider declarations.
 *
 * A profile is the code-side declaration of one OAuth-capable provider: endpoints, least-privilege
 * requested scopes, the scope→capability map used for discovery, and which deployment environment
 * variables carry the operator's OAuth client credentials. No provider is usable until an operator
 * provisions the client credentials — until then the hub shows a truthful CONNECT_REQUIRED-like
 * state and the authorize call fails closed instead of improvising a client identity.
 *
 * Inventing an endpoint is prohibited; a provider belongs here only with its documented, public
 * authorization and token endpoints and with the least scopes that serve the stated purpose.
 * Refresh and revocation are best-effort and both are verified against the provider by the operator
 * before enabling the profile. QA injects a fake provider and a fake OAuth server; the QA double
 * never ships in this module.
 */

export interface ReviewedConnectionProvider {
  readonly id: string;
  readonly version: string;
  readonly label: string;
  readonly purpose: string;
  /** Public, documented authorization endpoint. HTTPS only. */
  readonly authorizationUrl: string;
  /** Public, documented token endpoint. HTTPS only. */
  readonly tokenUrl: string;
  /** Optional revocation endpoint (best-effort disconnect). HTTPS only. */
  readonly revokeUrl?: string;
  /** Least-privilege scopes we will ask for. Never more than the adapter needs. */
  readonly requestedScopes: readonly string[];
  /** How granted scopes map to customer-visible capabilities (discovery is scope-derived, no HTTP). */
  readonly scopeCapabilities: Readonly<Record<string, string>>;
  /** Names of the deployment env vars that carry the operator's client credentials. */
  readonly clientIdEnv: string;
  readonly clientSecretEnv: string;
  /** Where the browser lands after the provider redirects (absolute API URL, operator-registered). */
  readonly redirectEnv: string;
  /** provider publishes expiry on the token response; absence means non-expiring access tokens. */
  readonly accessTokenLifetimeSeconds?: number;
}

/**
 * Google Workspace — OpenID Connect least-privilege identity read used as the first reviewed
 * profile. No Workspace data scopes are requested; mail/calendar/drive access would be separate
 * profiles requiring their own review and must not be added here by widening these scopes.
 */
export const GOOGLE_WORKSPACE_PROVIDER: ReviewedConnectionProvider = {
  id: 'google-workspace',
  version: '1',
  label: 'Google Workspace',
  purpose: 'Connect a Google Workspace account to identify the workspace owner on behalf of this QeyNox workspace.',
  authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  revokeUrl: 'https://oauth2.googleapis.com/revoke',
  requestedScopes: ['openid', 'email', 'profile'],
  scopeCapabilities: { openid: 'identity.openid', email: 'account.email', profile: 'account.profile' },
  clientIdEnv: 'QEYNOX_GOOGLE_WORKSPACE_CLIENT_ID',
  clientSecretEnv: 'QEYNOX_GOOGLE_WORKSPACE_CLIENT_SECRET',
  redirectEnv: 'QEYNOX_GOOGLE_WORKSPACE_REDIRECT_URI',
};

export const REVIEWED_CONNECTION_PROVIDERS: readonly ReviewedConnectionProvider[] = [GOOGLE_WORKSPACE_PROVIDER];

export interface ProviderAvailability {
  readonly clientConfigured: boolean;
  readonly redirectConfigured: boolean;
  /** What is missing, or null when fully configured. */
  readonly missing: readonly string[];
}

export function providerAvailability(provider: ReviewedConnectionProvider, env: NodeJS.ProcessEnv = process.env): ProviderAvailability {
  const missing: string[] = [];
  if (!(env[provider.clientIdEnv] ?? '').trim()) missing.push(provider.clientIdEnv);
  if (!(env[provider.clientSecretEnv] ?? '').trim()) missing.push(provider.clientSecretEnv);
  if (!(env[provider.redirectEnv] ?? '').trim()) missing.push(provider.redirectEnv);
  const clientConfigured = Boolean((env[provider.clientIdEnv] ?? '').trim()) && Boolean((env[provider.clientSecretEnv] ?? '').trim());
  const redirectConfigured = Boolean((env[provider.redirectEnv] ?? '').trim());
  return { clientConfigured, redirectConfigured, missing };
}

/**
 * Whether the deployment can start an OAuth flow for the provider at all. Credentials are read from
 * env at call time; values never leave this module except inside the token request itself.
 */
export function providerClientCredentials(provider: ReviewedConnectionProvider, env: NodeJS.ProcessEnv = process.env): { clientId: string; clientSecret: string; redirectUri: string } | null {
  const clientId = (env[provider.clientIdEnv] ?? '').trim();
  const clientSecret = (env[provider.clientSecretEnv] ?? '').trim();
  const redirectUri = (env[provider.redirectEnv] ?? '').trim();
  if (!clientId || !clientSecret || !redirectUri) return null;
  try {
    const url = new URL(redirectUri);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) return null;
    if (url.username || url.password || url.hash) return null;
  } catch { return null; }
  return { clientId, clientSecret, redirectUri };
}

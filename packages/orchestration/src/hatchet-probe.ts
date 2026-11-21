import { connect } from 'node:net';

/**
 * MISSION A21.07 — bounded, read-only probe of the Hatchet deployment the worker would dispatch to.
 *
 * Endpoint resolution mirrors the installed SDK (@hatchet-dev/typescript-sdk 1.46.1,
 * `util/config-loader`): the tenant is the token's `sub` claim; the API URL is
 * `HATCHET_CLIENT_API_URL`, else the token's `server_url` claim; the engine (gRPC) address is
 * `HATCHET_CLIENT_HOST_PORT`, else the token's `grpc_broadcast_address` claim. The token is decoded
 * only to read those routing claims; its signature is verified by Hatchet itself (step 3 below).
 *
 * Probe steps, all under the caller's AbortSignal (one deadline for the whole probe):
 * 1. `GET /api/ready` (unauthenticated): the API server reports itself ready.
 * 2. `GET /api/v1/version` (unauthenticated): the server version, part of the deployment identity.
 * 3. `GET /api/v1/tenants/{sub}` with the token: Hatchet accepts the credential AND serves the tenant
 *    the token names (`metadata.id` must equal `sub`).
 * 4. TCP connect to the engine gRPC address: the dispatch endpoint accepts connections.
 *
 * Nothing here returns, logs or embeds the token. Remote text is not echoed: failures are reported
 * as a status code or a network error code only.
 */
export interface HatchetEndpoints {
  readonly tenantId: string;
  /** Origin of the Hatchet API server, e.g. `https://hatchet.internal`. */
  readonly apiOrigin: string;
  readonly grpcHost: string;
  readonly grpcPort: number;
}

export type HatchetEndpointResolution =
  | { readonly ok: true; readonly endpoints: HatchetEndpoints }
  | { readonly ok: false; readonly missing: readonly string[] };

export interface HatchetProbeEnvironment {
  readonly token: string | undefined;
  readonly apiUrl?: string | undefined;
  readonly hostPort?: string | undefined;
}

export type HatchetProbeFailure = 'UNREACHABLE' | 'UNHEALTHY' | 'AUTH_REJECTED' | 'IDENTITY_MISMATCH' | 'INVALID_RESPONSE';

export type HatchetProbeReport =
  | { readonly ok: true; readonly version: string; readonly tenantId: string; readonly tenantSlug: string | null }
  | { readonly ok: false; readonly failure: HatchetProbeFailure; readonly detail: string };

function tokenClaims(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const json = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const claims: unknown = JSON.parse(json);
    return claims && typeof claims === 'object' && !Array.isArray(claims) ? claims as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function claim(claims: Record<string, unknown>, name: string): string | undefined {
  const value = claims[name];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function apiOriginOf(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function hostPortOf(value: string): { host: string; port: number } | null {
  // `host:port` or `[ipv6]:port`; a scheme is tolerated (some deployments write grpc://host:port).
  const bare = value.replace(/^[a-z]+:\/\//i, '');
  const match = /^(\[[^\]]+\]|[^:/\s]+):(\d{1,5})$/.exec(bare);
  if (!match) return null;
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host: match[1]!.replace(/^\[|\]$/g, ''), port };
}

/** Resolve where Hatchet lives without contacting it. Never echoes the token. */
export function resolveHatchetEndpoints(env: HatchetProbeEnvironment): HatchetEndpointResolution {
  const token = (env.token ?? '').trim();
  if (!token) return { ok: false, missing: ['HATCHET_CLIENT_TOKEN'] };
  const claims = tokenClaims(token);
  const tenantId = claims ? claim(claims, 'sub') : undefined;
  if (!claims || !tenantId) return { ok: false, missing: ['HATCHET_CLIENT_TOKEN (not a Hatchet tenant token: the sub claim is unreadable)'] };
  const missing: string[] = [];
  const apiSource = (env.apiUrl ?? '').trim() || claim(claims, 'server_url');
  const apiOrigin = apiSource ? apiOriginOf(apiSource) : null;
  if (!apiSource) missing.push('HATCHET_CLIENT_API_URL (the token carries no server_url claim)');
  else if (!apiOrigin) missing.push('HATCHET_CLIENT_API_URL (not an http(s) URL without credentials)');
  const grpcSource = (env.hostPort ?? '').trim() || claim(claims, 'grpc_broadcast_address');
  const grpc = grpcSource ? hostPortOf(grpcSource) : null;
  if (!grpcSource) missing.push('HATCHET_CLIENT_HOST_PORT (the token carries no grpc_broadcast_address claim)');
  else if (!grpc) missing.push('HATCHET_CLIENT_HOST_PORT (expected host:port)');
  if (missing.length || !apiOrigin || !grpc) return { ok: false, missing };
  return { ok: true, endpoints: { tenantId, apiOrigin, grpcHost: grpc.host, grpcPort: grpc.port } };
}

type HttpResult =
  | { readonly kind: 'ok'; readonly status: number; readonly json: unknown }
  | { readonly kind: 'status'; readonly status: number }
  | { readonly kind: 'error'; readonly code: string };

function networkCode(error: unknown): string {
  const cause = error instanceof Error ? (error as Error & { cause?: { code?: unknown } }).cause : undefined;
  if (cause && typeof cause.code === 'string') return cause.code;
  if (error instanceof Error && error.name === 'AbortError') return 'ABORTED';
  if (error instanceof Error && error.name === 'TimeoutError') return 'TIMEOUT';
  return 'NETWORK_ERROR';
}

/**
 * A pooled keep-alive connection to a deployment that has since restarted fails on first use. That is
 * not evidence about the deployment, so an idempotent GET is retried once on a fresh connection (still
 * inside the caller's deadline). Any other failure is reported as observed.
 */
const STALE_CONNECTION_CODES = new Set(['UND_ERR_SOCKET', 'ECONNRESET', 'UND_ERR_CLOSED', 'EPIPE']);

async function fetchOnce(url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (error: unknown) {
    if (signal.aborted || !STALE_CONNECTION_CODES.has(networkCode(error))) throw error;
    return fetch(url, init);
  }
}

async function getJson(url: string, signal: AbortSignal, token?: string): Promise<HttpResult> {
  try {
    const response = await fetchOnce(url, {
      method: 'GET',
      redirect: 'error',
      signal,
      headers: { accept: 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    }, signal);
    const raw = await response.text();
    if (!response.ok) return { kind: 'status', status: response.status };
    let json: unknown = null;
    try { json = raw.length ? JSON.parse(raw) : null; } catch { json = null; }
    return { kind: 'ok', status: response.status, json };
  } catch (error: unknown) {
    return { kind: 'error', code: networkCode(error) };
  }
}

function tcpReachable(host: string, port: number, signal: AbortSignal): Promise<{ ok: true } | { ok: false; code: string }> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve({ ok: false, code: 'ABORTED' }); return; }
    const socket = connect({ host, port });
    const finish = (result: { ok: true } | { ok: false; code: string }) => {
      signal.removeEventListener('abort', onAbort);
      socket.destroy();
      resolve(result);
    };
    const onAbort = () => finish({ ok: false, code: 'ABORTED' });
    signal.addEventListener('abort', onAbort, { once: true });
    socket.once('connect', () => finish({ ok: true }));
    socket.once('error', (error: NodeJS.ErrnoException) => finish({ ok: false, code: typeof error.code === 'string' ? error.code : 'NETWORK_ERROR' }));
  });
}

/** Run the four probe steps. The caller owns the deadline through `signal`. */
export async function probeHatchet(endpoints: HatchetEndpoints, token: string, signal: AbortSignal): Promise<HatchetProbeReport> {
  const ready = await getJson(new URL('/api/ready', endpoints.apiOrigin).href, signal);
  if (ready.kind === 'error') return { ok: false, failure: 'UNREACHABLE', detail: 'API readiness request failed (' + ready.code + ')' };
  if (ready.kind === 'status') return { ok: false, failure: 'UNHEALTHY', detail: 'API readiness returned HTTP ' + ready.status };

  const version = await getJson(new URL('/api/v1/version', endpoints.apiOrigin).href, signal);
  if (version.kind === 'error') return { ok: false, failure: 'UNREACHABLE', detail: 'version request failed (' + version.code + ')' };
  if (version.kind === 'status') return { ok: false, failure: 'UNHEALTHY', detail: 'version endpoint returned HTTP ' + version.status };
  const versionValue = (version.json as { version?: unknown } | null)?.version;
  if (typeof versionValue !== 'string' || !versionValue.trim() || versionValue.length > 64) {
    return { ok: false, failure: 'INVALID_RESPONSE', detail: 'version endpoint did not return a version string' };
  }

  const tenant = await getJson(new URL('/api/v1/tenants/' + encodeURIComponent(endpoints.tenantId), endpoints.apiOrigin).href, signal, token);
  if (tenant.kind === 'error') return { ok: false, failure: 'UNREACHABLE', detail: 'tenant request failed (' + tenant.code + ')' };
  if (tenant.kind === 'status') {
    if (tenant.status === 401 || tenant.status === 403) return { ok: false, failure: 'AUTH_REJECTED', detail: 'Hatchet rejected the client token (HTTP ' + tenant.status + ')' };
    if (tenant.status === 404) return { ok: false, failure: 'IDENTITY_MISMATCH', detail: 'this API does not serve the tenant named by the token (HTTP 404)' };
    return { ok: false, failure: 'UNHEALTHY', detail: 'tenant endpoint returned HTTP ' + tenant.status };
  }
  const body = tenant.json as { metadata?: { id?: unknown }; slug?: unknown } | null;
  if (typeof body?.metadata?.id !== 'string') return { ok: false, failure: 'INVALID_RESPONSE', detail: 'tenant response is not in the documented shape' };
  if (body.metadata.id !== endpoints.tenantId) return { ok: false, failure: 'IDENTITY_MISMATCH', detail: 'the tenant answered is not the tenant named by the token' };

  const engine = await tcpReachable(endpoints.grpcHost, endpoints.grpcPort, signal);
  if (!engine.ok) return { ok: false, failure: 'UNREACHABLE', detail: 'engine gRPC address did not accept a connection (' + engine.code + ')' };

  const slug = typeof body.slug === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(body.slug) ? body.slug : null;
  return { ok: true, version: versionValue.trim(), tenantId: endpoints.tenantId, tenantSlug: slug };
}

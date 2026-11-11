import type { IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';
import { DomainError } from '@qeynox/domain';
/**
 * Operator-declared outbound policy for provider adapters.
 * The host allowlist alone is NOT proof against DNS rebinding: provider requests additionally
 * resolve the hostname, reject private/reserved addresses, pin the validated IP for the actual
 * TLS connection, refuse HTTP redirects and enforce byte/time caps.
 */
export interface EgressPolicyConfig { attested: boolean; allowedHosts: readonly string[] }
export class EgressPolicy {
  readonly attested: boolean;
  readonly allowedHosts: ReadonlySet<string>;
  constructor(config: EgressPolicyConfig) {
    this.attested = config.attested === true;
    this.allowedHosts = new Set(config.allowedHosts.map(host => host.trim().toLowerCase()).filter(Boolean));
  }
  assertAllowed(url: URL): void {
    if (!this.attested) throw new DomainError('NOT_CONFIGURED', 'Network egress policy is not attested');
    if (!this.allowedHosts.size) throw new DomainError('NOT_CONFIGURED', 'No provider host is allowlisted for egress');
    if (url.protocol !== 'https:') throw new DomainError('DENIED', 'Only HTTPS provider endpoints are permitted');
    if (url.username || url.password) throw new DomainError('DENIED', 'Provider URL must not embed credentials');
    if (url.port && url.port !== '443') throw new DomainError('DENIED', 'Provider URL uses a non-standard port');
    if (!this.allowedHosts.has(url.hostname.toLowerCase())) throw new DomainError('DENIED', 'Provider host is outside the egress allowlist: ' + url.hostname);
  }
}
export function egressPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): EgressPolicy {
  return new EgressPolicy({
    attested: env.QEYNOX_NETWORK_POLICY_ATTESTED === 'true',
    allowedHosts: (env.QEYNOX_EGRESS_ALLOWED_HOSTS ?? '').split(',').map(host => host.trim()).filter(Boolean),
  });
}

const ipv4Part = (value: string): number => Number(value);
function ipv4Reserved(address: string): boolean {
  const parts = address.split('.').map(ipv4Part);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b, c] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127 || a >= 224) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a === 169 && b === 254) return true; // link-local incl. cloud metadata 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 0) return true; // IETF protocol assignments/documentation
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  return false;
}
function mappedIpv4(address: string): string | undefined {
  const lower = address.toLowerCase();
  if (!lower.startsWith('::ffff:')) return undefined;
  const tail = lower.slice('::ffff:'.length);
  if (isIP(tail) === 4) return tail;
  const groups = tail.split(':');
  if (groups.length !== 2) return undefined;
  const highGroup = groups[0];
  const lowGroup = groups[1];
  if (highGroup === undefined || lowGroup === undefined) return undefined;
  const high = Number.parseInt(highGroup, 16);
  const low = Number.parseInt(lowGroup, 16);
  if (!Number.isInteger(high) || !Number.isInteger(low)) return undefined;
  return [(high >> 8) & 255, high & 255, (low >> 8) & 255, low & 255].join('.');
}
/** True for addresses that a public provider call must never target (loopback, private, metadata, multicast, documentation). */
export function isPrivateOrReservedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return ipv4Reserved(address);
  if (family !== 6) return true;
  const lower = address.toLowerCase();
  const mapped = mappedIpv4(lower);
  if (mapped) return ipv4Reserved(mapped);
  if (lower === '::' || lower === '::1') return true;
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true; // link-local
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique local
  if (lower.startsWith('ff')) return true; // multicast
  if (lower.startsWith('2001:db8')) return true; // documentation
  return false;
}
export interface ResolvedAddress { address: string; family: number }
export type ProviderResolver = (host: string) => Promise<readonly ResolvedAddress[]>;
const defaultResolver: ProviderResolver = async host => {
  const results = await dns.lookup(host, { all: true, verbatim: true });
  return results.map(result => ({ address: result.address, family: result.family }));
};
export function assertPublicProviderAddress(address: string, host: string): void {
  if (!isIP(address)) throw new DomainError('DENIED', 'Provider host resolved to an invalid address: ' + host);
  if (isPrivateOrReservedAddress(address)) throw new DomainError('DENIED', 'Provider host resolved to a private or reserved address: ' + host);
}
/** Resolves once, rejects IP literals and any mixed/private DNS answers, and returns the pinned address. */
export async function resolvePinnedProviderAddress(host: string, resolver: ProviderResolver = defaultResolver): Promise<ResolvedAddress> {
  if (isIP(host)) throw new DomainError('DENIED', 'Provider host must be a hostname, not an IP literal');
  let addresses: readonly ResolvedAddress[];
  try { addresses = await resolver(host); } catch { throw new DomainError('NOT_CONFIGURED', 'Provider host could not be resolved: ' + host); }
  if (!addresses.length) throw new DomainError('NOT_CONFIGURED', 'Provider host did not resolve: ' + host);
  for (const address of addresses) assertPublicProviderAddress(address.address, host);
  return addresses[0]!;
}
export function isRedirectStatus(status: number): boolean { return status >= 300 && status < 400; }
export interface ProviderRequestOptions {
  signal?: AbortSignal;
  headers?: Readonly<Record<string, string>>;
  maxBytes?: number;
  timeoutMs?: number;
  resolver?: ProviderResolver;
}
export interface ProviderHttpResponse { status: number; headers: IncomingHttpHeaders; body: string }
/**
 * HTTPS provider request with a pinned validated address, no redirect following (3xx is DENIED),
 * byte/time caps and no credential forwarding beyond explicit headers.
 */
export async function secureProviderRequest(url: URL, policy: EgressPolicy, options: ProviderRequestOptions = {}): Promise<ProviderHttpResponse> {
  policy.assertAllowed(url);
  const pinned = await resolvePinnedProviderAddress(url.hostname, options.resolver);
  const maxBytes = options.maxBytes ?? 500_000;
  return new Promise<ProviderHttpResponse>((resolve, reject) => {
    let settled = false;
    const finalize = (error?: DomainError, result?: ProviderHttpResponse) => {
      if (settled) return;
      settled = true;
      if (error) reject(error); else resolve(result!);
    };
    const request = httpsRequest({
      protocol: 'https:',
      hostname: url.hostname,
      port: 443,
      path: url.pathname + url.search,
      method: 'GET',
      servername: url.hostname,
      headers: { accept: 'application/json', ...options.headers },
      lookup: ((_hostname: string, details: unknown, callback: (error: NodeJS.ErrnoException | null, address: unknown, family?: number) => void) => {
        // Node may request all resolved addresses for Happy Eyeballs; always return the single pinned address.
        const wantsAll = Boolean(details && typeof details === 'object' && (details as { all?: boolean }).all);
        if (wantsAll) callback(null, [{ address: pinned.address, family: pinned.family }]);
        else callback(null, pinned.address, pinned.family);
      }) as never,
      signal: options.signal,
      timeout: options.timeoutMs ?? 15_000,
    }, response => {
      const status = response.statusCode ?? 0;
      if (isRedirectStatus(status)) {
        response.resume();
        finalize(new DomainError('DENIED', 'Provider redirect is not permitted'));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) {
          response.destroy();
          finalize(new DomainError('INVALID_STATE', 'Provider payload too large'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => finalize(undefined, { status, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
      response.on('error', error => finalize(new DomainError('INVALID_STATE', 'Provider response failed: ' + (error instanceof Error ? error.message : 'unknown'))));
    });
    request.on('timeout', () => { request.destroy(); finalize(new DomainError('INVALID_STATE', 'Provider request timed out')); });
    request.on('error', error => finalize(new DomainError('INVALID_STATE', 'Provider connection failed: ' + (error instanceof Error ? error.message : 'unknown'))));
    request.end();
  });
}





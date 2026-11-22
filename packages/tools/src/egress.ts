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
  if (a === 192 && b === 88 && c === 99) return true; // deprecated 6to4 relay
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  return false;
}
/**
 * Only ordinary global-unicast IPv6 is eligible for public provider connections.
 * Parse numeric prefix groups after WHATWG canonicalization: textual prefix checks alone miss
 * expanded/zero-padded forms. Transition mechanisms are deliberately denied, even when their
 * embedded IPv4 looks public, so routing cannot translate a vetted IPv6 address to a private IP.
 */
export function isPrivateOrReservedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return ipv4Reserved(address);
  if (family !== 6 || address.includes('%')) return true;
  const canonical = new URL('http://[' + address + ']/').hostname.slice(1, -1);
  const groups = canonical.split(':');
  const first = Number.parseInt(groups[0] || '0', 16);
  const second = Number.parseInt(groups[1] || '0', 16);
  // 2000::/3: excludes loopback, unspecified, mapped IPv4, NAT64, discard, site/link/unique
  // local, multicast and unallocated space without relying on their presentation.
  if ((first & 0xe000) !== 0x2000) return true;
  if (first === 0x2001 && second < 0x0200) return true; // IETF assignments incl. Teredo, ORCHID, benchmarking
  if (first === 0x2001 && second === 0x0db8) return true; // documentation
  if (first === 0x2002) return true; // 6to4 embeds an IPv4 destination
  if (first === 0x3fff && second < 0x1000) return true; // 3fff::/20 documentation
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
  /** Defaults to GET. POST is only for reviewed, attested provider calls that need a JSON body. */
  method?: 'GET' | 'POST';
  /** UTF-8 JSON body for method POST; written verbatim with an exact content-length. */
  body?: string;
}
export interface ProviderHttpResponse { status: number; headers: IncomingHttpHeaders; body: string }
/**
 * HTTPS provider request with a pinned validated address, no redirect following (3xx is DENIED),
 * byte/time caps and no credential forwarding beyond explicit headers.
 */
export async function secureProviderRequest(url: URL, policy: EgressPolicy, options: ProviderRequestOptions = {}): Promise<ProviderHttpResponse> {
  policy.assertAllowed(url);
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxBytes = options.maxBytes ?? 500_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 10 * 1024 * 1024) throw new DomainError('INVALID_INPUT', 'Invalid provider transport bounds');
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const timeoutError = () => new DomainError('UNAVAILABLE', 'Provider deadline or cancellation', { providerFailure: 'TIMEOUT' });
  try {
    // DNS cannot always be cancelled by the OS; race it and never open a socket after the deadline.
    let abortDns: (() => void) | undefined;
    const dnsDeadline = new Promise<never>((_, reject) => {
      abortDns = () => reject(timeoutError());
      if (signal.aborted) abortDns(); else signal.addEventListener('abort', abortDns, { once: true });
    });
    let pinned: ResolvedAddress;
    try { pinned = await Promise.race([resolvePinnedProviderAddress(url.hostname, options.resolver), dnsDeadline]); }
    finally { if (abortDns) signal.removeEventListener('abort', abortDns); }
    if (signal.aborted) throw timeoutError();
    return await new Promise<ProviderHttpResponse>((resolve, reject) => {
      let settled = false;
      const onAbort = () => finalize(timeoutError());
      const finalize = (error?: DomainError, result?: ProviderHttpResponse) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        if (error) reject(error); else resolve(result!);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      const request = httpsRequest({
        protocol: 'https:', hostname: url.hostname, port: 443,
        path: url.pathname + url.search, method: options.method ?? 'GET', servername: url.hostname,
        headers: options.body === undefined
          ? { accept: 'application/json', ...options.headers }
          : { accept: 'application/json', ...options.headers, 'content-length': Buffer.byteLength(options.body) },
        lookup: ((_hostname: string, details: unknown, callback: (error: NodeJS.ErrnoException | null, address: unknown, family?: number) => void) => {
          const wantsAll = Boolean(details && typeof details === 'object' && (details as { all?: boolean }).all);
          if (wantsAll) callback(null, [{ address: pinned.address, family: pinned.family }]);
          else callback(null, pinned.address, pinned.family);
        }) as never,
        signal, timeout: timeoutMs,
      }, response => {
        const status = response.statusCode ?? 0;
        if (isRedirectStatus(status)) {
          response.destroy();
          finalize(new DomainError('DENIED', 'Provider redirect is not permitted'));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            response.destroy();
            finalize(new DomainError('INVALID_STATE', 'Provider payload too large', { providerFailure: 'INVALID_RESPONSE' }));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => finalize(undefined, { status, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
        response.on('aborted', () => finalize(new DomainError('UNAVAILABLE', 'Provider response interrupted')));
        response.on('error', () => finalize(new DomainError('UNAVAILABLE', 'Provider response failed')));
      });
      request.on('timeout', () => { request.destroy(); finalize(timeoutError()); });
      request.on('error', () => finalize(signal.aborted ? timeoutError() : new DomainError('UNAVAILABLE', 'Provider connection failed')));
      if (options.body !== undefined) request.write(options.body);
      request.end();
    });
  } finally { clearTimeout(timer); controller.abort(); }
}

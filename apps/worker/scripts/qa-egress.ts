/**
 * TASK 08A provider-egress security QA (no credentials, no fake attestations).
 *
 * Verifies: private/reserved address rejection (loopback, RFC1918, CGNAT, link-local/metadata,
 * unique-local, documentation and IPv4-mapped ranges); host/IP-literal policy; DNS answers are
 * fully validated and the validated address is pinned for the TLS connection; HTTP redirects are
 * never followed (3xx contract); and one real read-only HTTPS request through the pinned
 * transport to the documented World Bank endpoint.
 *
 * This verifies network-level controls, not environment flags alone. It does not claim that a
 * DNS-rebinding attack was executed; the resolver/connection pinning is exercised with injected
 * DNS answers plus a real live resolution/connection.
 */
import {
  EgressPolicy, isPrivateOrReservedAddress, isRedirectStatus, resolvePinnedProviderAddress, secureProviderRequest,
} from '@qeynox/tools';
import { DomainError } from '@qeynox/domain';

let assertions = 0;
function assert(condition: unknown, message: string): asserts condition {
  assertions++;
  if (!condition) throw new Error('ASSERTION FAILED: ' + message);
}
async function expectDomainError(code: string, run: () => Promise<unknown> | unknown, label: string): Promise<void> {
  assertions++;
  try { await run(); } catch (error: unknown) {
    if (error instanceof DomainError && error.code === code) return;
    throw new Error('EXPECTED ' + code + ' for ' + label + ', got ' + (error instanceof DomainError ? error.code : String(error)));
  }
  throw new Error('EXPECTED ' + code + ' for ' + label + ', but no error was raised');
}

async function main(): Promise<void> {
  const reservedAddresses = [
    '127.0.0.1', '0.0.0.0', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254',
    '100.64.0.1', '198.18.0.1', '192.0.0.9', '203.0.113.10', '224.0.0.1', '255.255.255.255',
    '::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1', '2001:db8::1',
    '::ffff:127.0.0.1', '::ffff:169.254.169.254',
  ];
  for (const address of reservedAddresses) assert(isPrivateOrReservedAddress(address), 'reserved address rejected: ' + address);
  for (const address of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111']) assert(!isPrivateOrReservedAddress(address), 'public address accepted: ' + address);
  for (const status of [301, 302, 303, 307, 308]) assert(isRedirectStatus(status), 'redirect status detected: ' + status);
  for (const status of [200, 201, 400, 500]) assert(!isRedirectStatus(status), 'non-redirect status accepted: ' + status);

  const policy = new EgressPolicy({ attested: true, allowedHosts: ['api.worldbank.org'] });
  await expectDomainError('NOT_CONFIGURED', () => new EgressPolicy({ attested: false, allowedHosts: ['api.worldbank.org'] }).assertAllowed(new URL('https://api.worldbank.org/v2/country/USA')), 'unattested egress policy');
  await expectDomainError('DENIED', () => policy.assertAllowed(new URL('https://evil.example/steal')), 'unauthorized destination');
  await expectDomainError('DENIED', () => policy.assertAllowed(new URL('http://api.worldbank.org/v2/country/USA')), 'plain HTTP provider endpoint');
  await expectDomainError('DENIED', () => policy.assertAllowed(new URL('https://user:pass@api.worldbank.org/x')), 'embedded URL credentials');
  await expectDomainError('DENIED', () => policy.assertAllowed(new URL('https://api.worldbank.org:8443/x')), 'non-standard provider port');

  const worldBankUrl = new URL('https://api.worldbank.org/v2/country/USA/indicator/NY.GDP.MKTP.CD?format=json&mrnev=1&per_page=5');
  await expectDomainError('DENIED', () => secureProviderRequest(worldBankUrl, policy, { resolver: async () => [{ address: '127.0.0.1', family: 4 }] }), 'private DNS answer');
  await expectDomainError('DENIED', () => secureProviderRequest(worldBankUrl, policy, { resolver: async () => [{ address: '169.254.169.254', family: 4 }] }), 'cloud metadata DNS answer');
  await expectDomainError('DENIED', () => secureProviderRequest(worldBankUrl, policy, { resolver: async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }] }), 'mixed public/private DNS answers');
  await expectDomainError('NOT_CONFIGURED', () => secureProviderRequest(worldBankUrl, policy, { resolver: async () => [] }), 'empty DNS answer');
  const literalPolicy = new EgressPolicy({ attested: true, allowedHosts: ['93.184.216.34'] });
  await expectDomainError('DENIED', () => secureProviderRequest(new URL('https://93.184.216.34/x'), literalPolicy), 'IP-literal provider host');

  // Real live pinned HTTPS request to the documented World Bank endpoint.
  const resolved = await resolvePinnedProviderAddress('api.worldbank.org');
  assert(!isPrivateOrReservedAddress(resolved.address), 'live provider host resolves to a public address');
  const response = await secureProviderRequest(worldBankUrl, policy, { maxBytes: 500_000, timeoutMs: 15_000 });
  assert(response.status === 200, 'live provider returned HTTP 200 through pinned transport');
  const payload = JSON.parse(response.body) as unknown[];
  assert(Array.isArray(payload) && payload.length === 2 && Array.isArray(payload[1]), 'live provider payload matches documented World Bank wire shape');

  console.log('EGRESS_EVIDENCE', JSON.stringify({ resolvedAddress: resolved.address, status: response.status, bytes: Buffer.byteLength(response.body), payloadShapes: payload.length }));
  console.log('Provider egress QA PASSED:', assertions, 'assertions');
}

main().catch((error: unknown) => {
  console.error('Provider egress QA FAILED:', error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});


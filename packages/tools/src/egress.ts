import { DomainError } from '@qeynox/domain';
/**
 * Operator-declared outbound policy for provider adapters.
 * The host allowlist is a necessary code-level guard, NOT proof against DNS rebinding or
 * compromised infrastructure: provider reachability still requires pinned network egress.
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

import { DomainError } from '@qeynox/domain';
/**
 * In-process sliding-window provider rate limit. Multi-worker deployments need a shared
 * limiter (provider-side quota or durable ledger) because this state is per broker instance.
 */
export class ProviderRateLimiter {
  private readonly calls = new Map<string, number[]>();
  private readonly windowMs = 60_000;
  check(provider: string, maxPerMinute: number): void | Promise<void> {
    if (!Number.isInteger(maxPerMinute) || maxPerMinute < 1) throw new DomainError('NOT_CONFIGURED', 'Provider rate limit is not configured: ' + provider);
    const now = Date.now();
    const recent = (this.calls.get(provider) ?? []).filter(at => at > now - this.windowMs);
    if (recent.length >= maxPerMinute) throw new DomainError('BUDGET_EXHAUSTED', 'Provider rate limit exceeded: ' + provider);
    recent.push(now);
    this.calls.set(provider, recent);
  }
}

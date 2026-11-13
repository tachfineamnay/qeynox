import { createHash, randomUUID } from 'node:crypto';
import { createClient } from 'redis';
import { DomainError } from '@qeynox/domain';
import { ProviderRateLimiter } from './rate-limit';

// Redis TIME avoids clock skew between workers; the entire reservation is atomic.
const reserve = `
local t=redis.call('TIME')
local now=t[1]*1000+math.floor(t[2]/1000)
redis.call('ZREMRANGEBYSCORE',KEYS[1],'-inf',now-60000)
if redis.call('ZCARD',KEYS[1])>=tonumber(ARGV[1]) then return 0 end
redis.call('ZADD',KEYS[1],now,ARGV[2])
redis.call('PEXPIRE',KEYS[1],60000)
return 1`;

export class RedisProviderRateLimiter extends ProviderRateLimiter {
  private readonly client;
  private connecting?: Promise<unknown>;
  constructor(url: string) {
    super();
    this.client = createClient({ url, disableOfflineQueue: true, socket: { connectTimeout: 5000, reconnectStrategy: false } });
    this.client.on('error', () => { /* check() returns a sanitized fail-closed error. */ });
  }
  override async check(provider: string, maxPerMinute: number): Promise<void> {
    if (!Number.isInteger(maxPerMinute) || maxPerMinute < 1) throw new DomainError('NOT_CONFIGURED','Invalid provider quota');
    try {
      if (!this.client.isOpen) this.connecting ??= this.client.connect().finally(() => { this.connecting = undefined; });
      await this.connecting;
      const key = 'qeynox:provider-quota:v1:' + createHash('sha256').update(provider).digest('hex');
      const accepted = await this.client.withCommandOptions({ abortSignal: AbortSignal.timeout(5000) }).eval(reserve, { keys: [key], arguments: [String(maxPerMinute), randomUUID()] });
      if (accepted !== 1) throw new DomainError('BUDGET_EXHAUSTED','Provider rate limit exceeded: ' + provider);
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError('NOT_CONFIGURED','Shared provider quota is unavailable');
    }
  }
  async close(): Promise<void> { if (this.client.isOpen) await this.client.quit(); }
}

let shared: RedisProviderRateLimiter | undefined;
export function configuredProviderRateLimiter(): ProviderRateLimiter {
  const url = process.env.QEYNOX_REDIS_URL;
  if (url) return shared ??= new RedisProviderRateLimiter(url);
  if (process.env.NODE_ENV === 'production') throw new DomainError('NOT_CONFIGURED','Shared Redis quota required in production');
  return new ProviderRateLimiter();
}

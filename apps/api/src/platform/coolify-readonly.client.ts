import { DomainError } from '@qeynox/domain';
import type { ResourceInventoryCapability, ResourceInventoryItem, ResourceInventoryPort } from '@qeynox/application';

interface CoolifyConfig { readonly baseUrl: string; readonly token: string; readonly project: string; readonly environment: string }
interface CoolifyResource { readonly id: string; readonly type: 'SERVER' | 'APPLICATION' | 'SERVICE'; readonly name: string; readonly status: string; readonly fqdn: string | null }

function readConfig(env: NodeJS.ProcessEnv): { readonly config: CoolifyConfig | null; readonly missing: readonly string[] } {
  const base = (env.QEYNOX_COOLIFY_BASE_URL ?? '').trim();
  const token = (env.QEYNOX_COOLIFY_API_TOKEN ?? '').trim();
  const project = (env.QEYNOX_COOLIFY_PROJECT_UUID ?? '').trim();
  const environment = (env.QEYNOX_COOLIFY_ENVIRONMENT ?? '').trim();
  const missing: string[] = [];
  if (!base) missing.push('QEYNOX_COOLIFY_BASE_URL');
  if (!token) missing.push('QEYNOX_COOLIFY_API_TOKEN');
  if (!project) missing.push('QEYNOX_COOLIFY_PROJECT_UUID');
  if (!environment) missing.push('QEYNOX_COOLIFY_ENVIRONMENT');
  if (missing.length) return { config: null, missing };
  let url: URL;
  try { url = new URL(base); } catch { return { config: null, missing: ['QEYNOX_COOLIFY_BASE_URL_INVALID'] }; }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && loopback))) return { config: null, missing: ['QEYNOX_COOLIFY_BASE_URL_INSECURE'] };
  if (url.username || url.password || url.search || url.hash) return { config: null, missing: ['QEYNOX_COOLIFY_BASE_URL_INVALID'] };
  if (!/^[A-Za-z0-9_-]+$/.test(project) || !/^[A-Za-z0-9_-]+$/.test(environment)) return { config: null, missing: ['QEYNOX_COOLIFY_SCOPE_INVALID'] };
  return { config: { baseUrl: base.replace(/\/+$/, ''), token, project, environment }, missing: [] };
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.data)) return record.data;
    if (Array.isArray(record.payload)) return record.payload;
  }
  return [];
}

/**
 * Read-only Coolify inventory adapter. Only GET requests are implemented: no deploy, restart, stop,
 * exec or Docker command exists in this class. Without both server variables the capability stays
 * NOT_CONFIGURED; an upstream failure is reported as UNAVAILABLE, never replaced by invented data.
 */
export class CoolifyReadOnlyClient implements ResourceInventoryPort {
  private readonly config: CoolifyConfig | null;
  private readonly missing: readonly string[];
  constructor(env: NodeJS.ProcessEnv = process.env) {
    const loaded = readConfig(env);
    this.config = loaded.config;
    this.missing = loaded.missing;
  }

  private capability(status: ResourceInventoryCapability['status'], reason: string | null): ResourceInventoryCapability {
    return { provider: 'COOLIFY', status, reason, readOnly: true };
  }

  private async get(path: string): Promise<unknown> {
    if (!this.config) throw new DomainError('NOT_CONFIGURED', 'Coolify is not configured: ' + this.missing.join('|'));
    let response: Response;
    try {
      response = await fetch(this.config.baseUrl + '/api/v1' + path, {
        method: 'GET',
        redirect: 'error',
        headers: { authorization: 'Bearer ' + this.config.token, accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
    } catch { throw new DomainError('UNAVAILABLE', 'Coolify API is unreachable'); }
    if (!response.ok) throw new DomainError('UNAVAILABLE', 'Coolify API request failed (' + response.status + ')');
    try { return await response.json() as unknown; } catch { throw new DomainError('UNAVAILABLE', 'Coolify API returned invalid JSON'); }
  }

  private items(raw: unknown, type: CoolifyResource['type']): readonly CoolifyResource[] {
    return asArray(raw).flatMap(entry => {
      if (typeof entry !== 'object' || entry === null) return [];
      const value = entry as Record<string, unknown>;
      const id = value.uuid ?? value.id;
      const name = value.name ?? value.fqdn ?? (type === 'SERVER' ? value.ip : null);
      if (id === undefined || id === null || name === undefined || name === null) return [];
      return [{
        id: String(id), type, name: String(name),
        status: value.status === undefined || value.status === null ? 'unknown' : String(value.status),
        fqdn: value.fqdn === undefined || value.fqdn === null ? null : String(value.fqdn),
      }];
    });
  }

  async list(): Promise<{ readonly capability: ResourceInventoryCapability; readonly resources: readonly ResourceInventoryItem[] }> {
    if (!this.config) return { capability: this.capability('NOT_CONFIGURED', this.missing.join('|')), resources: [] };
    try {
      const raw = await this.get('/projects/' + encodeURIComponent(this.config.project) + '/' + encodeURIComponent(this.config.environment));
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new DomainError('UNAVAILABLE', 'Coolify environment response invalid');
      const env = raw as Record<string, unknown>;
      if ((env.name !== this.config.environment && env.uuid !== this.config.environment) || !Array.isArray(env.applications) || !Array.isArray(env.services)) {
        throw new DomainError('UNAVAILABLE', 'Coolify environment inventory is not supported by this API');
      }
      const resources = [...this.items(env.applications, 'APPLICATION'), ...this.items(env.services, 'SERVICE')];
      return { capability: this.capability('CONFIGURED', null), resources };
    } catch (error) {
      const reason = error instanceof DomainError ? error.message : 'COOLIFY_API_UNAVAILABLE';
      return { capability: this.capability('UNAVAILABLE', reason), resources: [] };
    }
  }
}

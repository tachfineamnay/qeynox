import { z } from 'zod';
import { DomainError, type ID } from '@qeynox/domain';
import type { ToolConnector, ToolDefinition, ToolContext } from '../types';
import type { ConnectorManifest } from '../manifest';
import { secureProviderRequest, type EgressPolicy } from '../egress';

/**
 * MISSION A15 — Brave Search API adapter (licensed web search).
 *
 * A REAL provider with a commercial subscription: every request bills against the operator's Brave
 * Search plan (as of 2026-11, the Search plan is priced per thousand requests — see licenseNotes).
 * Activation is therefore triple-gated:
 *   1. an ACTIVE operator TOOL configuration entry (createConfiguredToolRegistry) — no entry, the
 *      connector does not exist on this deployment;
 *   2. QEYNOX_BRAVE_SEARCH_ENABLED=true on the API/worker deployment;
 *   3. attested egress (QEYNOX_NETWORK_POLICY_ATTESTED=true, api.search.brave.com in
 *      QEYNOX_EGRESS_ALLOWED_HOSTS) plus the subscription token in QEYNOX_BRAVE_SEARCH_API_KEY.
 *
 * The subscription token is sent ONLY in the X-Subscription-Token header — never in the URL, never
 * logged, never in error messages (mirroring the vault's posture). The provider endpoint is the
 * documented public endpoint; there is no "search emulator" fallback anywhere in this file.
 *
 * Tool surface is deliberately minimal: one read-only web search with pagination and a freshness
 * filter. No local/POI enrichment, no Answers API, no images, no news — each is a separate
 * reviewed profile if ever needed. Consent scope `web:search` is required: the query text leaves
 * this deployment to a third party.
 *
 * QA injects a loopback transport (the only permitted test double); production uses the
 * DNS-pinned, no-redirect egress client like every reviewed provider.
 */

const ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';

const request = z.object({
  query: z.string().trim().min(1, 'query must not be empty').max(400),
  count: z.number().int().min(1).max(20).default(10),
  offset: z.number().int().min(0).max(9).default(0),
  safesearch: z.enum(['off', 'moderate', 'strict']).default('moderate'),
  country: z.string().trim().regex(/^[A-Za-z]{2}$/).transform(value => value.toUpperCase()).optional(),
  searchLang: z.string().trim().regex(/^[A-Za-z]{2}$/).transform(value => value.toLowerCase()).optional(),
  freshness: z.string().trim().regex(/^(pd|pw|pm|py|\d{4}-\d{2}-\d{2}to\d{4}-\d{2}-\d{2})$/, 'freshness must be pd|pw|pm|py or YYYY-MM-DDtoYYYY-MM-DD').optional(),
});

const resultRow = z.object({
  title: z.string(),
  url: z.url(),
  description: z.string().default(''),
  age: z.string().optional(),
  page_age: z.string().optional(),
  profile: z.object({ name: z.string().optional() }).optional(),
});
const responseBody = z.object({
  web: z.object({ results: z.array(resultRow) }).optional(),
  query: z.object({ original: z.string().optional() }).optional(),
});

const output = z.object({
  provider: z.literal('brave-search'),
  query: z.string(),
  results: z.array(z.object({
    title: z.string(),
    url: z.url(),
    description: z.string(),
    age: z.string().optional(),
    source: z.string().optional(),
  })),
  sourceUri: z.url(),
  retrievedAt: z.string(),
});

/** Transport seam. Production: DNS-pinned egress client. QA: loopback fake (never ships as product). */
export interface SearchTransport {
  get(url: URL, options: { headers: Record<string, string>; signal?: AbortSignal; maxBytes: number; timeoutMs: number }): Promise<{ status: number; body: string }>;
}
export class SecureSearchTransport implements SearchTransport {
  constructor(private readonly egress: EgressPolicy) {}
  async get(url: URL, options: { headers: Record<string, string>; signal?: AbortSignal; maxBytes: number; timeoutMs: number }): Promise<{ status: number; body: string }> {
    const response = await secureProviderRequest(url, this.egress, {
      signal: options.signal,
      headers: options.headers,
      maxBytes: options.maxBytes,
      timeoutMs: options.timeoutMs,
    });
    return { status: response.status, body: response.body };
  }
}

export class BraveSearchConnector implements ToolConnector {
  readonly id = 'brave-search';
  readonly version = '1';
  private readonly transport: SearchTransport;
  constructor(
    private readonly capabilities: readonly ID[],
    private readonly egress: EgressPolicy,
    /** Server-side subscription token. Required; the registry refuses to build without it. */
    private readonly apiKey: string,
    transport?: SearchTransport,
  ) {
    this.transport = transport ?? new SecureSearchTransport(egress);
  }
  definitions(): readonly ToolDefinition[] {
    return [{
      name: 'web', version: '1', mode: 'READ',
      requiredScopes: ['web:search'],
      allowedCapabilities: this.capabilities,
      input: request, output,
      timeoutMs: 10000, maxCostUnits: 0,
    }];
  }
  async invoke(name: string, version: string, input: unknown, context: ToolContext) {
    if (name !== 'web' || version !== this.version) throw new DomainError('UNSUPPORTED', 'Unknown Brave Search tool');
    const values = request.parse(input);
    const url = new URL(ENDPOINT);
    url.searchParams.set('q', values.query);
    url.searchParams.set('count', String(values.count));
    url.searchParams.set('offset', String(values.offset));
    url.searchParams.set('safesearch', values.safesearch);
    if (values.country) url.searchParams.set('country', values.country);
    if (values.searchLang) url.searchParams.set('search_lang', values.searchLang);
    if (values.freshness) url.searchParams.set('freshness', values.freshness);
    this.egress.assertAllowed(url);
    // The token never reaches the URL or the logs: header only.
    const response = await this.transport.get(url, {
      signal: context.signal,
      headers: { accept: 'application/json', 'x-subscription-token': this.apiKey },
      maxBytes: 500_000,
      timeoutMs: 10000,
    });
    if (response.status === 401 || response.status === 403) {
      throw new DomainError('NOT_CONFIGURED', 'Brave Search subscription token was rejected — check QEYNOX_BRAVE_SEARCH_API_KEY and the plan');
    }
    if (response.status === 429) {
      throw new DomainError('BUDGET_EXHAUSTED', 'Brave Search rate limit or quota exceeded');
    }
    if (response.status >= 500) {
      throw new DomainError('UNAVAILABLE', 'Brave Search responded HTTP ' + response.status);
    }
    if (response.status < 200 || response.status >= 300) {
      throw new DomainError('INVALID_STATE', 'Brave Search responded HTTP ' + response.status);
    }
    let json: unknown;
    try { json = JSON.parse(response.body); } catch {
      throw new DomainError('INVALID_STATE', 'Brave Search returned malformed JSON');
    }
    const parsed = responseBody.safeParse(json);
    if (!parsed.success) throw new DomainError('INVALID_STATE', 'Brave Search returned an unexpected payload shape');
    const rows = parsed.data.web?.results ?? [];
    const result = {
      provider: 'brave-search' as const,
      query: values.query,
      results: rows.map(row => ({
        title: row.title,
        url: row.url,
        description: row.description,
        ...(row.age ? { age: row.age } : row.page_age ? { age: row.page_age } : {}),
        ...(row.profile?.name ? { source: row.profile.name } : {}),
      })),
      sourceUri: url.toString(),
      retrievedAt: new Date().toISOString(),
    };
    return { value: output.parse(result), sourceUri: url.toString() };
  }
}

export const braveSearchManifest: ConnectorManifest = {
  id: 'brave-search', version: '1',
  description: 'Brave Search API — licensed web search with provenance (title, url, description, retrieval time)',
  provider: 'Brave',
  regions: ['GLOBAL'], operations: ['WEB_RESEARCH'],
  termsUrl: 'https://api-dashboard.search.brave.com/app/documentation/web-search/get-started',
  licenseNotes: 'Commercial subscription required: the operator must hold an active Brave Search API plan (as of 2026-11 the Search plan is about US$5 per 1,000 requests, plan pricing is the provider\'s to change) and comply with the Brave Search API Terms of Service. Results may not be republished to build a competing search index; attribution obligations depend on the plan tier — verify at subscription time. Query text leaves this deployment to Brave.',
  freshness: { ttlSeconds: 3600, publishedAtSource: 'UNKNOWN' },
  rateLimit: { maxPerMinute: 30 },
  mode: 'READ_ONLY',
  tools: [{ name: 'web', version: '1' }],
};

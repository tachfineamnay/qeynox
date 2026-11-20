/**
 * MISSION A15 — licensed web search (Brave) adapter QA.
 *
 *  PART 1 — CONTRACTS (pure, always runnable)
 *   - typed input contract: bounds, enums, freshness grammar; every malformed variant rejected;
 *   - output contract parses adapter output;
 *   - reviewed manifest invariants (READ_ONLY, web@1, reviewed rate ceiling) + bundle validation;
 *   - the adapter refuses to construct without a server-side token at the registry boundary.
 *
 *  PART 2 — BROKER PATH (isolated disposable database + loopback FAKE Brave server)
 *   - the fake server runs on 127.0.0.1 inside this process only; it is the only OAuth-less double
 *     permitted in QA and NEVER substitutes for the provider in product;
 *   - operator bundle (infra/operator/a15-web-research.json) applies cleanly; the ACTIVE TOOL
 *     configuration is required for registration — without QEYNOX_BRAVE_SEARCH_ENABLED or the
 *     token, registration fails closed with NOT_CONFIGURED;
 *   - broker end-to-end invoke with consent scope web:search → provenance (provider, sourceUri,
 *     response digest), ledger COMPLETED, pagination/params/headers verified by the fake server;
 *   - permission paths: missing consent → DENIED; tool outside profile → DENIED; zero tool calls
 *     remaining → DENIED; replayed intent → CONFLICT;
 *   - provider failure mapping: 401 → NOT_CONFIGURED, 429 → BUDGET_EXHAUSTED, 500 → UNAVAILABLE,
 *     malformed JSON / wrong payload shape → INVALID_STATE;
 *   - egress: registry refuses to build when api.search.brave.com is not allowlisted.
 *
 * NO claim of a live provider call is made anywhere in this file: the live leg is BLOCKED in this
 * environment (no Brave subscription token; sandbox egress denies the host). A run without PART 2
 * is NOT integration evidence.
 *
 * Run: pnpm --filter @qeynox/worker qa:brave-search
 * Exit: 0 PASS · 3 BLOCKED · 1 FAILED
 */
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { and, eq } from 'drizzle-orm';
import {
  QeyNoxStore, connectDatabase, runMigrations,
  identityMemberships, identityUsers, identityWorkspaces, toolLedger,
} from '@qeynox/persistence';
import { ConfigurationService, PlanningService } from '@qeynox/application';
import {
  EgressPolicy, PgToolLedger, ToolBroker, ToolRegistry,
  BraveSearchConnector, braveSearchManifest, createConfiguredToolRegistry,
  type ConnectorCall, type PermissionContext, type SearchTransport,
} from '@qeynox/tools';
import { validateBundle } from '@qeynox/tools';
import { DomainError, type ID, type Principal } from '@qeynox/domain';
import { createIsolatedQaDatabase } from '../../api/scripts/qa-isolated-database';

const PASS = 0;
const FAILED = 1;
const BLOCKED = 3;

let assertions = 0;
function check(condition: unknown, message: string): asserts condition {
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
class BlockedSignal extends Error { constructor(readonly reason: string) { super(reason); this.name = 'BlockedSignal'; } }

const egress = new EgressPolicy({ attested: true, allowedHosts: ['api.search.brave.com'] });

const qaConnector = new BraveSearchConnector([], egress, 'qa-token');
const definitions = qaConnector.definitions();
type ParsedInput = { query: string; count: number; offset: number; safesearch: 'off' | 'moderate' | 'strict'; country?: string; searchLang?: string; freshness?: string };
const input = definitions[0]!.input as { parse(value: unknown): ParsedInput; safeParse(value: unknown): { success: boolean } };
const output = definitions[0]!.output as { parse(value: unknown): { results: Array<{ title: string }> } };
const parseInput = (value: unknown): ParsedInput => input.parse(value);

// =============================================================================================
// PART 1 — contracts and manifest invariants
// =============================================================================================
function partOne(): void {
  console.log('— PART 1: contracts and reviewed manifest —');
  const before = assertions;

  // Input acceptance
  check(parseInput({ query: 'qeynox' }).count === 10 && parseInput({ query: 'qeynox' }).offset === 0 && parseInput({ query: 'qeynox' }).safesearch === 'moderate', 'defaults are count=10, offset=0, safesearch=moderate');
  const full = parseInput({ query: '  QeyNox RaaS  ', count: 20, offset: 9, safesearch: 'strict', country: 'fr', searchLang: 'EN', freshness: 'pw' });
  check(full.query === 'QeyNox RaaS' && full.offset === 9 && full.country === 'FR' && full.searchLang === 'en', 'explicit values parse and normalize');
  check(parseInput({ query: 'q', freshness: '2026-01-01to2026-06-30' }).freshness === '2026-01-01to2026-06-30', 'freshness accepts an explicit date range');

  // Input rejection (every malformed variant)
  const rejections: Array<[string, unknown]> = [
    ['empty query', { query: '   ' }],
    ['oversized query', { query: 'x'.repeat(401) }],
    ['zero results requested', { query: 'a', count: 0 }],
    ['too many results', { query: 'a', count: 21 }],
    ['fractional count', { query: 'a', count: 2.5 }],
    ['offset beyond page ceiling', { query: 'a', offset: 10 }],
    ['negative offset', { query: 'a', offset: -1 }],
    ['unknown safesearch', { query: 'a', safesearch: 'lax' }],
    ['three-letter country', { query: 'a', country: 'FRA' }],
    ['country with digit', { query: 'a', country: 'F1' }],
    ['three-letter search language', { query: 'a', searchLang: 'eng' }],
    ['freshness word', { query: 'a', freshness: 'yesterday' }],
    ['freshness month value', { query: 'a', freshness: 'pm2' }],
    ['missing query', {}],
  ];
  for (const [label, value] of rejections) check(!input.safeParse(value).success, 'input rejected: ' + label);

  // Output contract: parses a well-formed value and normalizes age
  const parsedOut = output.parse({
    provider: 'brave-search', query: 'qeynox',
    results: [{ title: 't', url: 'https://example.invalid/', description: 'd' }],
    sourceUri: 'https://api.search.brave.com/res/v1/web/search?q=qeynox',
    retrievedAt: new Date().toISOString(),
  });
  check(parsedOut.results.length === 1, 'output contract parses a well-formed result page');

  // Reviewed manifest invariants + bundle validation (READ_ONLY cannot expose writes)
  check(braveSearchManifest.mode === 'READ_ONLY', 'manifest is READ_ONLY');
  check(braveSearchManifest.tools.length === 1 && braveSearchManifest.tools[0]!.name === 'web', 'exactly one reviewed tool');
  check(braveSearchManifest.rateLimit.maxPerMinute <= 30, 'reviewed rate ceiling is 30/min');
  check(new URL(braveSearchManifest.termsUrl!).hostname === 'api-dashboard.search.brave.com', 'terms URL is the documented provider page');
  validateBundle({ manifest: braveSearchManifest, connector: new BraveSearchConnector([], egress, 'qa-token') });
  assertions++;

  console.log('  PART 1 PASSED: cumulative ' + assertions + ' assertions (' + (assertions - before) + ' in this half)');
}

// =============================================================================================
// The loopback fake Brave server (QA only) and its transport.
// =============================================================================================
interface FakeBrave {
  port: number;
  readonly requests: Array<{ path: string; token: string | null; params: URLSearchParams }>;
  mode: 'OK' | 'UNAUTHORIZED' | 'RATE_LIMITED' | 'SERVER_ERROR' | 'MALFORMED_JSON' | 'WRONG_SHAPE';
  close(): Promise<void>;
}

async function startFakeBrave(): Promise<FakeBrave> {
  const state = {
    port: 0,
    requests: [] as Array<{ path: string; token: string | null; params: URLSearchParams }>,
    mode: 'OK' as FakeBrave['mode'],
    close: async () => { await new Promise<void>(resolve => server.close(() => resolve())); },
  };
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    state.requests.push({
      path: url.pathname,
      token: request.headers['x-subscription-token'] ? String(request.headers['x-subscription-token']) : null,
      params: url.searchParams,
    });
    const json = (status: number, body: unknown) => {
      const payload = typeof body === 'string' ? body : JSON.stringify(body);
      response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
      response.end(payload);
    };
    if (request.method !== 'GET' || url.pathname !== '/res/v1/web/search') return json(404, { error: 'unknown_endpoint' });
    switch (state.mode) {
      case 'OK':
        return json(200, {
          web: {
            results: [
              { title: 'QeyNox — results as a service', url: 'https://qeynox.example.invalid/', description: 'First result description', age: '2026-11-01T00:00:00Z' },
              { title: 'A second source', url: 'https://sources.example.invalid/guide', description: 'Second result description', page_age: '2026-10-15T00:00:00Z' },
              { title: 'Third source', url: 'https://example.invalid/third', description: 'Third result description', profile: { name: 'example.invalid' } },
            ],
          },
          query: { original: url.searchParams.get('q') ?? '' },
        });
      case 'UNAUTHORIZED': return json(401, { error: { code: 'SUBSCRIPTION_TOKEN_INVALID', detail: 'bad token' } });
      case 'RATE_LIMITED': return json(429, { error: { code: 'RATE_LIMIT', detail: 'slow down' } });
      case 'SERVER_ERROR': return json(500, { error: { code: 'INTERNAL', detail: 'provider fault' } });
      case 'MALFORMED_JSON': return json(200, 'this is not json');
      case 'WRONG_SHAPE': return json(200, { web: { results: 'not-an-array' } });
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  state.port = (server.address() as AddressInfo).port;
  return state;
}

/** QA-only transport: speaks real HTTP to the loopback fake. Production uses SecureSearchTransport. */
class FakeBraveTransport implements SearchTransport {
  constructor(private readonly baseUrl: string) {}
  async get(url: URL, options: { headers: Record<string, string>; signal?: AbortSignal; maxBytes: number; timeoutMs: number }): Promise<{ status: number; body: string }> {
    const target = new URL(url.pathname + url.search, this.baseUrl);
    const response = await fetch(target, { headers: options.headers, signal: options.signal });
    return { status: response.status, body: await response.text() };
  }
}

// =============================================================================================
// PART 2 — registry wiring and broker path against a disposable database
// =============================================================================================
async function partTwo(): Promise<'PASSED' | 'BLOCKED'> {
  console.log('— PART 2: operator activation, registry fail-closed, broker path —');
  if (!process.env.QEYNOX_QA_DATABASE_URL) {
    console.log('BLOCKED: PART 2 not run — QEYNOX_QA_DATABASE_URL is not set. This run is NOT integration evidence.');
    return 'BLOCKED';
  }
  const qa = await createIsolatedQaDatabase();
  process.env.DATABASE_URL = qa.url;
  const fake = await startFakeBrave();
  let connection: ReturnType<typeof connectDatabase> | undefined;
  try {
    const migration = await runMigrations(qa.url);
    check(migration.total > 0, 'disposable QA database migrated');
    connection = connectDatabase(qa.url);
    const db = connection.db;
    const store = new QeyNoxStore(db);

    const ownerId = randomUUID();
    process.env.QEYNOX_OPERATOR_USER_IDS = ownerId;
    const workspaceId = randomUUID();
    await db.insert(identityUsers).values([{ id: ownerId, email: 'qa-a15-owner-' + ownerId + '@example.invalid' }]);
    await db.insert(identityWorkspaces).values([{ id: workspaceId, name: 'QA A15 Workspace', createdBy: ownerId }]);
    await db.insert(identityMemberships).values([{ id: randomUUID(), userId: ownerId, workspaceId, role: 'OWNER', status: 'ACTIVE' }]);
    const owner: Principal = { userId: ownerId as ID, workspaceId: workspaceId as ID, roles: ['OWNER'] };

    // --- Apply the reviewed operator bundle ---------------------------------------------------
    const bundle = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('../../../infra/operator/a15-web-research.json', import.meta.url), 'utf8')) as Record<string, unknown>;
    const configuration = new ConfigurationService(store);
    await configuration.apply(owner, { idempotencyKey: String(bundle.idempotencyKey), entries: bundle.entries } as never);

    // --- Registry: fail-closed without the deployment switch, the token or the allowlist ------
    await expectDomainError('NOT_CONFIGURED', () => createConfiguredToolRegistry(db, { worldBankEnabled: false, braveSearchEnabled: false, braveSearchApiKey: 'qa-brave-key', egress }), 'configured provider with ENABLE switch off');
    await expectDomainError('NOT_CONFIGURED', () => createConfiguredToolRegistry(db, { worldBankEnabled: false, braveSearchEnabled: true, braveSearchApiKey: undefined, egress }), 'configured provider without the subscription token');
    await expectDomainError('DENIED', () => createConfiguredToolRegistry(db, { worldBankEnabled: false, braveSearchEnabled: true, braveSearchApiKey: 'qa-brave-key', egress: new EgressPolicy({ attested: true, allowedHosts: ['example.invalid'] }) }), 'registry built without the provider host allowlisted');

    const productionRegistry = await createConfiguredToolRegistry(db, { worldBankEnabled: false, braveSearchEnabled: true, braveSearchApiKey: 'qa-brave-key', egress });
    const found = productionRegistry.lookup('brave-search', 'web', '1');
    check(found.definition.mode === 'READ' && found.definition.requiredScopes.includes('web:search'), 'the reviewed tool is registered read-only with the consent scope');
    check(productionRegistry.manifest('brave-search').rateLimit.maxPerMinute === 10, 'operator-configured rate ceiling replaces the reviewed one (tightened)');

    // --- Broker path with the loopback fake transport -----------------------------------------
    const registry = new ToolRegistry();
    registry.registerBundle({
      manifest: { ...braveSearchManifest, rateLimit: { maxPerMinute: 10 } },
      connector: new BraveSearchConnector(['capability-slot-1-v1' as ID], egress, 'qa-brave-key', new FakeBraveTransport('http://127.0.0.1:' + fake.port)),
    });
    const broker = new ToolBroker(registry, new PgToolLedger(db));
    const operation = await store.createOperation(owner, 'QA A15 web research', 'Retrieve licensed web evidence through ToolBroker', []);
    const planning = new PlanningService(store);
    const plan = await planning.create(owner, operation.id, operation.version, [{
      title: 'Search the web', description: 'Search Brave for one specific query', capabilityId: 'capability-slot-1-v1' as ID, dependsOnIndices: [], intent: 'RESEARCH',
    }]);
    // Brokered reads against the loopback fake only. The full executor path (commerce accept +
    // OperationExecutionService) is intentionally NOT exercised: the reviewed operator bundle ships
    // no offer and no budget mapping, so that path fails closed by design until an operator approves
    // spend explicitly.
    const attemptId = randomUUID() as ID;

    const basePermission: PermissionContext = {
      principal: owner, operationId: operation.id, planRevisionId: plan.revision.id, stepAttemptId: attemptId,
      capabilityId: 'capability-slot-1-v1' as ID, profileId: 'qa-profile' as ID, profileVersion: 1,
      allowedConnectorTools: ['brave-search:web@1'], consentScopes: ['web:search'],
      approvedRequests: [], remainingCostUnits: 0, remainingToolCalls: 2,
    };
    const callFor = (key: string, inputOverride: Record<string, unknown> = {}): ConnectorCall => ({
      operationId: operation.id, planRevisionId: plan.revision.id, stepAttemptId: attemptId,
      capabilityId: 'capability-slot-1-v1' as ID, connectorId: 'brave-search', toolName: 'web', version: '1',
      input: { query: 'QeyNox results as a service', count: 3, offset: 1, safesearch: 'moderate', country: 'fr', searchLang: 'fr', freshness: 'pw', ...inputOverride },
      idempotencyKey: 'qa-a15-' + key, intentId: randomUUID() as ID,
    });

    // Successful call (keep the call object: the replay test reuses its intentId)
    const firstCall = callFor('search-1');
    const result = await broker.invoke(firstCall, basePermission);
    const value = result.value as { provider: string; query: string; results: Array<{ title: string; url: string; description: string; age?: string; source?: string }>; sourceUri: string; retrievedAt: string };
    check(value.provider === 'brave-search', 'result identifies the licensed provider');
    check(value.results.length === 3, 'three results returned from the fake provider');
    check(value.results[0]!.url.startsWith('https://'), 'result URLs are real URLs');
    check(value.results[1]!.age === '2026-10-15T00:00:00Z', 'page_age is surfaced as age');
    check(value.results[2]!.source === 'example.invalid', 'publisher profile name is surfaced as source');
    check(typeof result.provenance.sourceUri === 'string' && new URL(result.provenance.sourceUri).hostname === 'api.search.brave.com', 'provenance source URI is the documented provider host');
    check(result.provenance.responseDigest.length === 64 && result.provenance.requestDigest.length === 64, 'provenance records request and response digests');
    check(result.provenance.provider === 'brave-search', 'provenance names the provider');

    // The fake server saw the exact wire shape: header token, path, all parameters
    check(fake.requests.length >= 1, 'fake server recorded the request');
    const seen = fake.requests[fake.requests.length - 1]!;
    check(seen.path === '/res/v1/web/search', 'documented endpoint path');
    check(seen.token === 'qa-brave-key', 'subscription token sent in the X-Subscription-Token header');
    check(seen.params.get('q') === 'QeyNox results as a service', 'query parameter passed through');
    check(seen.params.get('count') === '3' && seen.params.get('offset') === '1', 'pagination parameters passed through');
    check(seen.params.get('safesearch') === 'moderate' && seen.params.get('country') === 'FR' && seen.params.get('search_lang') === 'fr' && seen.params.get('freshness') === 'pw', 'safety, locale and freshness parameters passed through');
    check(!(seen.params.get('x-subscription-token') ?? ''), 'token is never in the URL');

    // Ledger records the completed tool call
    const ledgerRows = await db.select().from(toolLedger).where(and(eq(toolLedger.operationId, operation.id), eq(toolLedger.connector, 'brave-search')));
    check(ledgerRows.some(row => row.outcome === 'COMPLETED'), 'tool ledger records the completed call');

    // Consent and permission guards (fresh intents, no network reached)
    await expectDomainError('DENIED', () => broker.invoke(callFor('no-consent'), { ...basePermission, consentScopes: [] }), 'missing web:search consent');
    await expectDomainError('DENIED', () => broker.invoke(callFor('not-allowed-tool'), { ...basePermission, allowedConnectorTools: [] }), 'tool outside profile allowlist');
    await expectDomainError('DENIED', () => broker.invoke(callFor('no-tool-budget'), { ...basePermission, remainingToolCalls: 0 }), 'tool call budget exhausted');
    await expectDomainError('DENIED', () => broker.invoke(callFor('wrong-capability'), { ...basePermission, capabilityId: 'capability-slot-2-v1' as ID }), 'tool outside its capability');

    // Replayed intent is refused (idempotent at the ledger)
    await expectDomainError('CONFLICT', () => broker.invoke({ ...firstCall }, basePermission), 'replayed invocation intent');

    // Provider failure mapping (each mode is a distinct, reviewed mapping)
    for (const [mode, code] of [['UNAUTHORIZED', 'NOT_CONFIGURED'], ['RATE_LIMITED', 'BUDGET_EXHAUSTED'], ['SERVER_ERROR', 'UNAVAILABLE'], ['MALFORMED_JSON', 'INVALID_STATE'], ['WRONG_SHAPE', 'INVALID_STATE']] as const) {
      fake.mode = mode;
      await expectDomainError(code, () => broker.invoke(callFor('failure-' + mode), basePermission), 'provider mode ' + mode);
    }
    fake.mode = 'OK';

    // A second successful call after failures stays healthy
    const healthy = await broker.invoke(callFor('search-2'), basePermission);
    check((healthy.value as { results: unknown[] }).results.length === 3, 'adapter recovers after transient provider failures');

    // Egress guard: the adapter asserts the provider host is allowlisted even with an injected transport
    const strictAdapter = new BraveSearchConnector(['capability-slot-1-v1' as ID], new EgressPolicy({ attested: true, allowedHosts: ['example.invalid'] }), 'qa-brave-key', new FakeBraveTransport('http://127.0.0.1:' + fake.port));
    await expectDomainError('DENIED', () => strictAdapter.invoke('web', '1', { query: 'q' }, { principal: owner, operationId: operation.id, stepAttemptId: attemptId, signal: new AbortController().signal }), 'egress assertion inside invoke');

    console.log('  PART 2 PASSED: cumulative ' + assertions + ' assertions');
    return 'PASSED';
  } finally {
    await connection?.close().catch(() => undefined);
    await fake.close();
    await qa.drop().catch(error => console.error('QA database teardown warning:', error instanceof Error ? error.message : error));
  }
}

partOne();
try {
  const integration = await partTwo();
  if (integration === 'BLOCKED') {
    console.log('A15 BRAVE SEARCH QA PARTIAL — PART 1 PASSED (' + assertions + ' assertions), PART 2 BLOCKED.');
    console.log('This run is NOT integration evidence: the broker path and the registry wiring were not exercised.');
    process.exit(BLOCKED);
  }
  console.log('A15 BRAVE SEARCH QA PASSED: ' + assertions + ' assertions (PART 1 contracts + PART 2 broker path).');
  process.exit(PASS);
} catch (error: unknown) {
  if (error instanceof BlockedSignal) {
    console.log('A15 BRAVE SEARCH QA BLOCKED: ' + error.reason);
    process.exit(BLOCKED);
  }
  console.error('A15 BRAVE SEARCH QA FAILED:', error instanceof Error ? error.message : error);
  process.exit(FAILED);
}

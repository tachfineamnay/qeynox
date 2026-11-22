import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { DomainError, type ID } from '@qeynox/domain';
import { HermesAdapter, probeHermes, normalizeUsage, hermesSettingsFromEnv, hermesFailureFacts, classifyProviderFailure, type EngineRequest } from '../src/index';
import { RuntimeProbeMonitor, hermesProbeDefinition, type RuntimeProbeDefinition } from '../../application/src/runtime-probes';
import { renderHermesVertex } from '../../../infra/services/render-hermes-vertex.mjs';
import { diagnostics } from '../../../infra/release/contract.mjs';

const key = 'qa-hermes-contract-only';
const model = 'google/gemini-contract-test';
const request: EngineRequest = {
  workspaceId: 'qa-workspace' as ID, operationId: 'qa-operation' as ID, stepAttemptId: 'qa-attempt' as ID,
  correlationId: 'qa-correlation', userMessage: 'contract-only fixture prompt', context: {},
  profile: { id: 'qa-profile' as ID, role: 'business', version: 1, title: 'QA', systemInstructions: 'Contract fixture', skillRefs: [], allowedTools: ['qa:read@1'], permittedContextKeys: [], maxOutputTokens: 100, maxIterations: 1 },
};
async function fixture() {
  const state = { openAuth: false, rejectAuth: false, toolsets: { data: [{ name: 'terminal', enabled: false, configured: true, tools: ['terminal'] }] } as unknown,
    models: { data: [{ id: model }] } as unknown, health: true, delay: 0, postStatus: 200,
    postBody: { id: 'qa-run', model, choices: [{ message: { content: 'Fixture answer' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 } } as unknown,
    received: [] as Record<string, unknown>[], posts: 0,
  };
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (state.delay) await new Promise(resolve => setTimeout(resolve, state.delay));
    if (req.url === '/health') { res.end(JSON.stringify({ status: state.health ? 'ok' : 'down', platform: 'hermes-agent', version: 'fixture-p17' })); return; }
    if (!state.openAuth && (state.rejectAuth || req.headers.authorization !== 'Bearer ' + key)) { res.statusCode = 401; res.end('{}'); return; }
    if (req.url === '/v1/models') { res.end(JSON.stringify(state.models)); return; }
    if (req.url === '/v1/toolsets') { res.end(JSON.stringify(state.toolsets)); return; }
    if (req.method === 'POST') {
      state.posts++;
      let body = ''; for await (const chunk of req) body += String(chunk);
      state.received.push(JSON.parse(body) as Record<string, unknown>);
      res.statusCode = state.postStatus; res.end(JSON.stringify(state.postBody)); return;
    }
    res.statusCode = 404; res.end('{}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/v1/';
  const config = { baseUrl, apiKey: key, model, provider: 'vertex' as const, timeoutMs: 1000, nativeToolsIsolated: true, egressAttested: true };
  return { state, config, async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

test('model discovery requires exact model, enforced bearer auth and explicitly disabled toolsets', async () => {
  const f = await fixture();
  try {
    const report = await probeHermes(f.config);
    assert.equal(report.authenticated, true); assert.equal(report.activeModelAdvertised, true); assert.equal(report.nativeToolsIsolated, true);
    f.state.openAuth = true;
    assert.equal((await probeHermes(f.config)).authenticated, false, 'a public inventory is not authentication evidence');
    f.state.openAuth = false; f.state.rejectAuth = true;
    assert.equal((await probeHermes(f.config)).authRejected, true);
    f.state.rejectAuth = false;
    for (const toolsets of [{ data: [] }, { data: [{ name: 'terminal', configured: true, tools: [] }] }, { data: [null] }]) {
      f.state.toolsets = toolsets;
      assert.equal((await probeHermes(f.config)).nativeToolsIsolated, null, 'malformed or empty inventory is unknown, not isolated');
    }
    f.state.toolsets = { data: [{ name: 'terminal', enabled: true, configured: true, tools: [] }] };
    assert.equal((await probeHermes(f.config)).nativeToolsIsolated, false);
    f.state.models = { data: [{ id: 'hermes-agent' }] };
    assert.equal((await probeHermes(f.config)).activeModelAdvertised, false);
    assert.equal(f.state.posts, 0, 'discovery never sends inference');
  } finally { await f.close(); }
});

test('Hermes evidence fails and recovers independently of Hatchet; provider change invalidates evidence', async () => {
  const f = await fixture();
  const env: NodeJS.ProcessEnv = { HERMES_API_BASE_URL: f.config.baseUrl, HERMES_API_KEY: key, HERMES_MODEL: model, HERMES_PROVIDER: 'vertex', HERMES_NATIVE_TOOLS_ISOLATED: 'true', QEYNOX_NETWORK_POLICY_ATTESTED: 'true' };
  let hatchetHealthy = false;
  const hatchet: RuntimeProbeDefinition = { component: 'hatchet', configuration: () => ({ missing: [], attested: true, target: { endpoint: 'http://qa-hatchet', fingerprint: 'qa-hatchet' } }), secrets: () => [],
    async probe() { return hatchetHealthy ? { ok: true, identity: { endpoint: 'http://qa-hatchet', deployment: 'qa-tenant', version: 'fixture' } } : { ok: false, failure: 'UNREACHABLE', detail: 'fixture unavailable' }; } };
  const monitor = new RuntimeProbeMonitor([hermesProbeDefinition(env), hatchet], { timeoutMs: 500, freshnessMs: 10_000, intervalMs: 1000 });
  try {
    await monitor.probeAll();
    assert.equal(monitor.readiness().engine.verifiedLive, true); assert.equal(monitor.readiness().canExecute, false);
    hatchetHealthy = true; await monitor.probe('hatchet');
    assert.equal(monitor.readiness().canExecute, true);
    f.state.models = { data: [{ id: 'wrong-model' }] }; await monitor.probe('hermes');
    assert.equal(monitor.readiness().engine.verification.failure, 'MODEL_NOT_ADVERTISED');
    assert.equal(monitor.readiness().orchestrator.verifiedLive, true); assert.equal(monitor.readiness().canExecute, false);
    f.state.models = { data: [{ id: model }] }; await monitor.probe('hermes');
    assert.equal(monitor.readiness().canExecute, true);
    env.HERMES_PROVIDER = 'custom';
    assert.equal(monitor.readiness().engine.verification.status, 'TARGET_CHANGED');
    assert.equal(f.state.posts, 0);
  } finally { monitor.stop(); await f.close(); }
});

test('probe deadline bounds the whole multi-request discovery, not each request independently', async () => {
  const f = await fixture();
  try {
    f.state.delay = 80;
    const start = Date.now();
    const report = await probeHermes({ ...f.config, timeoutMs: 150 });
    assert.equal(report.authenticated, false);
    assert(Date.now() - start < 500);
    assert.equal(f.state.posts, 0);
  } finally { await f.close(); }
});

test('Vertex adapter dispatch is bounded and tool proposals never enable native function execution', async () => {
  const f = await fixture();
  try {
    const result = await new HermesAdapter(f.config).invoke(request);
    assert.equal(result.status, 'COMPLETED'); assert.deepEqual(result.usage, { inputTokens: 5, outputTokens: 7, totalTokens: 12 });
    assert.equal(f.state.received[0]?.model, model); assert.equal(f.state.received[0]?.stream, false);
    assert.equal('tools' in f.state.received[0]!, false); assert.equal('tool_choice' in f.state.received[0]!, false);
    await assert.rejects(new HermesAdapter({ ...f.config, model: 'hermes-agent' }).invoke(request), /Explicit google\/gemini/);
    await assert.rejects(new HermesAdapter({ ...f.config, timeoutMs: 2 ** 32 }).invoke(request), /timeout/);
    assert.equal(f.state.posts, 1, 'invalid model and timeout refused before dispatch');
    f.state.postBody = { choices: [{ message: { content: '', tool_calls: [{}] }, finish_reason: 'tool_calls' }] };
    await assert.rejects(new HermesAdapter(f.config).invoke(request), error => hermesFailureFacts(error)?.hermesFailure === 'NATIVE_TOOLS_DETECTED');
    f.state.postBody = { choices: [{ message: { content: 'x'.repeat(2 * 1024 * 1024 + 1) }, finish_reason: 'stop' }] };
    await assert.rejects(new HermesAdapter(f.config).invoke(request), error => hermesFailureFacts(error)?.hermesFailure === 'MALFORMED');
    f.state.postBody = { choices: [{ message: { content: ' ' }, finish_reason: 'stop' }] };
    await assert.rejects(new HermesAdapter(f.config).invoke(request), error => hermesFailureFacts(error)?.hermesFailure === 'MALFORMED');
  } finally { await f.close(); }
});

test('provider auth/quota/model failures are observable, never answers; logs omit remote credential bodies', async () => {
  const f = await fixture();
  const diagnostics: unknown[] = [];
  try {
    for (const [text, failure] of [['Permission denied Vertex model 403', 'PROVIDER_AUTH_REJECTED'], ['Vertex quota exceeded 429', 'PROVIDER_RATE_LIMITED'], ['Vertex model not found 404', 'PROVIDER_MODEL_UNAVAILABLE']] as const) {
      f.state.postStatus = 502;
      f.state.postBody = { error: { code: 'agent_incomplete', message: text + ' ' + key } };
      await assert.rejects(new HermesAdapter({ ...f.config, onDiagnostic: event => diagnostics.push(event) }).invoke(request), error => hermesFailureFacts(error)?.hermesFailure === failure);
    }
    assert.equal(JSON.stringify(diagnostics).includes(key), false);
    assert.equal(JSON.stringify(diagnostics).includes('contract-only fixture prompt'), false);
    assert.equal(classifyProviderFailure('Vertex resource exhausted'), 'PROVIDER_RATE_LIMITED');
    assert.equal(hermesFailureFacts(new DomainError('UNAVAILABLE', 'remote', { hermesFailure: 'TIMEOUT' }))?.recoveryState, 'RECONCILE_UNCONFIRMED_RUN');
    assert.equal(hermesFailureFacts(new DomainError('UNAVAILABLE', 'remote', { hermesFailure: 'secret-remote-code' })), undefined);
  } finally { await f.close(); }
});

test('unobserved, fractional/unsafe and inconsistent token counts cannot become metered-zero evidence', () => {
  for (const usage of [undefined, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }, { prompt_tokens: -1 }, { prompt_tokens: 0.5 }, { total_tokens: Number.MAX_SAFE_INTEGER + 1 }, { prompt_tokens: 20, completion_tokens: 4, total_tokens: 2 }]) assert.equal(normalizeUsage(usage).reported, false);
  assert.deepEqual(normalizeUsage({ prompt_tokens: 0, completion_tokens: 5, total_tokens: 7 }), { inputTokens: 0, outputTokens: 5, totalTokens: 7, reported: true });
  assert.equal(hermesSettingsFromEnv({ HERMES_PROVIDER: 'vertex' }).model, '');
  assert.throws(() => hermesSettingsFromEnv({ HERMES_PROVIDER: 'unconfigured-provider' }), /Unsupported HERMES_PROVIDER/);
});

test('offline Hermes-only mount/model contracts neither expose Vertex to apps nor claim isolation', async () => {
  const config = renderHermesVertex({ QEYNOX_HERMES_VERTEX_PROJECT: 'qa-project', QEYNOX_HERMES_VERTEX_REGION: 'global', QEYNOX_HERMES_VERTEX_MODEL: model });
  assert.deepEqual(config.platform_toolsets.api_server, []); assert.deepEqual(config.mcp_servers, {}); assert.deepEqual(config.fallback_model, []);
  assert.deepEqual(config.platforms.api_server.extra.model_routes[model], { provider: 'vertex', model });
  assert.throws(() => renderHermesVertex({}), /BLOCKED/);
  assert.throws(() => renderHermesVertex({ QEYNOX_HERMES_VERTEX_PROJECT: 'qa-project', QEYNOX_HERMES_VERTEX_REGION: 'us-central1', QEYNOX_HERMES_VERTEX_MODEL: 'google/gemini-3-pro-preview' }), /requires global/);
  const manifest = await readFile('infra/services/hermes.yml', 'utf8');
  assert.match(manifest, /target: \/run\/secrets\/qeynox-vertex-service-account.json/);
  assert.equal((manifest.match(/read_only: true/g) ?? []).length, 2);
  assert.equal((manifest.match(/create_host_path: false/g) ?? []).length, 2);
  assert.match(manifest, /traefik.enable=false/); assert.equal(/^\s+ports:/m.test(manifest), false);
  for (const role of ['web', 'api', 'worker', 'control']) {
    const issues = diagnostics(role, { GOOGLE_APPLICATION_CREDENTIALS: '/secret', VERTEX_CREDENTIALS_PATH: '/secret' });
    assert(issues.some(issue => issue.key === 'GOOGLE_APPLICATION_CREDENTIALS' && issue.code === 'VERTEX_CREDENTIAL_HERMES_ONLY'));
    assert(issues.some(issue => issue.key === 'VERTEX_CREDENTIALS_PATH' && issue.code === 'VERTEX_CREDENTIAL_HERMES_ONLY'));
    const docker = await readFile('infra/Dockerfile.' + role, 'utf8');
    assert.equal(/COPY.*(?:vertex-sa|service-account|credentials\.json)/.test(docker), false);
  }
});

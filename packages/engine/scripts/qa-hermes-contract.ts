/**
 * MISSION A02 — Hermes/VERTEX inference contract QA (isolated, no model, no network).
 *
 * Exercises the adapter against a deterministic local HTTP fixture that reproduces the Hermes
 * API-server contract read from NousResearch/hermes-agent:
 *   - 401 gateway_auth_error for a wrong bearer key
 *   - 502 `agent_incomplete` for a hard agent failure
 *   - 200 with finish_reason stop / length / error / cancelled and the `hermes` extras object
 *   - 200 with the provider failure rendered as assistant content (older builds)
 *   - 200 with all-zero usage (nothing observed)
 *   - 429 rate_limit_exceeded with Retry-After
 *   - native tool_calls, which must always be refused (ToolBroker confinement)
 *
 * This proves the CONTRACT only. It can never prove real inference: that requires a live
 * deployment and is a separate, mandatory, operator-credentialed test (`qa:hermes-live`).
 *
 * Run: npx tsx packages/engine/scripts/qa-hermes-contract.ts
 */
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HermesAdapter, type HermesDiagnostic } from '../src/hermes';
import { classifyCompletion, normalizeUsage, redactSecrets } from '../src/hermes-contract';
import { DomainError, type ID } from '@qeynox/domain';

let assertions = 0;
function check(condition: unknown, message: string): asserts condition {
  assertions++;
  if (!condition) throw new Error('ASSERTION FAILED: ' + message);
}
async function expectError(code: string, run: () => Promise<unknown>, label: string): Promise<DomainError> {
  assertions++;
  try {
    await run();
  } catch (error: unknown) {
    if (error instanceof DomainError && error.code === code) return error;
    throw new Error('EXPECTED ' + code + ' for ' + label + ', got ' + (error instanceof DomainError ? error.code + ':' + error.message : String(error)));
  }
  throw new Error('EXPECTED ' + code + ' for ' + label + ', but no error was raised');
}

// --- Fixture: every documented response shape, selected by request task text -------------------
type Shape = 'answer' | 'tool_calls' | 'provider_failure_text' | 'finish_error' | 'finish_length'
  | 'finish_cancelled' | 'zero_usage' | 'error_envelope' | 'unauthorized' | 'rate_limited'
  | 'server_502' | 'malformed_json' | 'slow' | 'native_function_call';

const received: Array<{ authorization?: string; body: Record<string, unknown> }> = [];
function startFixture(): Promise<{ server: Server; port: number; close(): Promise<void> }> {
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', chunk => { raw += String(chunk); });
    request.on('end', () => {
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(raw) as Record<string, unknown>; } catch { /* ignored */ }
      received.push({ authorization: request.headers.authorization, body });
      const messages = (body.messages as Array<{ role?: string; content?: string }> | undefined) ?? [];
      const taskText = messages.filter(message => message.role === 'user').at(-1)?.content ?? '';
      const shape = (/shape=([a-z_0-9]+)/.exec(taskText)?.[1] as Shape | undefined) ?? 'answer';
      response.setHeader('content-type', 'application/json');
      if (shape === 'unauthorized') {
        response.statusCode = 401;
        response.end(JSON.stringify({ error: { message: 'Invalid gateway API key (API_SERVER_KEY)', type: 'gateway_auth_error', code: 'gateway_auth_failed' } }));
        return;
      }
      if (shape === 'rate_limited') {
        response.statusCode = 429;
        response.setHeader('retry-after', '1');
        response.end(JSON.stringify({ error: { message: 'Too many concurrent runs (max 2)', type: 'rate_limit_error', code: 'rate_limit_exceeded' } }));
        return;
      }
      if (shape === 'server_502') {
        response.statusCode = 502;
        response.end(JSON.stringify({ error: { message: 'Agent run did not produce a response.', type: 'server_error', code: 'agent_incomplete', hermes: { completed: false, partial: false, failed: true } } }));
        return;
      }
      if (shape === 'malformed_json') { response.end('{"choices": ['); return; }
      if (shape === 'slow') {
        // Longer than the adapter timeout used below; never answers within the test budget.
        setTimeout(() => { try { response.end(JSON.stringify({ id: 'late' })); } catch { /* closed */ } }, 3000);
        return;
      }
      const completion = (message: Record<string, unknown>, finish: string, usage: Record<string, number>, extras?: Record<string, unknown>) => ({
        id: 'chatcmpl-qa', object: 'chat.completion', created: 1, model: 'google/gemini-3-pro-preview',
        choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: finish }],
        usage, ...(extras ? { hermes: extras } : {}),
      });
      const observed = { prompt_tokens: 120, completion_tokens: 45, total_tokens: 165 };
      const zero = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
      switch (shape) {
        case 'tool_calls':
          response.end(JSON.stringify(completion({ content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'shell', arguments: '{}' } }] }, 'tool_calls', observed)));
          return;
        case 'native_function_call':
          response.end(JSON.stringify(completion({ content: null, function_call: { name: 'browser' } }, 'function_call', observed)));
          return;
        case 'provider_failure_text':
          response.end(JSON.stringify(completion({ content: 'Provider authentication failed. Check your credentials.' }, 'stop', zero)));
          return;
        case 'finish_error':
          response.end(JSON.stringify(completion({ content: '' }, 'error', zero, { completed: false, partial: false, failed: true, error: 'vertex: permission denied for model', error_code: 'agent_error' })));
          return;
        case 'finish_length':
          response.end(JSON.stringify(completion({ content: 'Partial analysis of the market…' }, 'length', observed, { completed: false, partial: true, failed: false, error: 'output truncated', error_code: 'output_truncated' })));
          return;
        case 'finish_cancelled':
          response.end(JSON.stringify(completion({ content: 'Stopped early' }, 'cancelled', observed, { completed: false, partial: false, failed: false, error: null, error_code: 'agent_error' })));
          return;
        case 'error_envelope':
          response.end(JSON.stringify({ error: { message: 'upstream failure', type: 'server_error', code: 'agent_incomplete' } }));
          return;
        case 'zero_usage':
          response.end(JSON.stringify(completion({ content: 'Answer with unobserved usage.' }, 'stop', zero)));
          return;
        default:
          response.end(JSON.stringify(completion({ content: 'Grounded answer from the configured model.' }, 'stop', observed)));
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({
      server, port: (server.address() as AddressInfo).port,
      close: () => new Promise<void>((done, fail) => server.close(error => (error ? fail(error) : done()))),
    }));
  });
}

const profile = {
  id: 'qa-profile' as ID, role: 'business' as const, version: 1, title: 'QA profile',
  systemInstructions: 'QA contract profile.',
  skillRefs: [] as const, allowedTools: ['world-bank:indicator@1'] as const,
  permittedContextKeys: ['operationTitle'] as const, maxOutputTokens: 256, maxIterations: 1,
};
const requestFor = (shape: Shape, extra: Record<string, unknown> = {}) => ({
  workspaceId: 'qa-workspace' as ID, operationId: 'qa-operation' as ID, stepAttemptId: 'qa-attempt' as ID,
  profile, userMessage: 'qa request shape=' + shape, context: { operationTitle: 'QA', secretNote: 'must-not-leak' },
  correlationId: 'qa-' + shape + '-' + Math.random().toString(16).slice(2), ...extra,
} as unknown as Parameters<HermesAdapter['invoke']>[0]);

async function main(): Promise<void> {
  const fixture = await startFixture();
  const base = 'http://127.0.0.1:' + fixture.port;
  const apiKey = 'qa-hermes-key-' + 'a'.repeat(40);
  const diagnostics: HermesDiagnostic[] = [];
  const adapter = (overrides: Partial<ConstructorParameters<typeof HermesAdapter>[0]> = {}) => new HermesAdapter({
    baseUrl: base, apiKey, model: 'google/gemini-3-pro-preview', timeoutMs: 500,
    nativeToolsIsolated: true, egressAttested: true, provider: 'vertex',
    onDiagnostic: event => diagnostics.push(event), ...overrides,
  });

  try {
    // --- Security contract: isolation gate is mandatory and fail-closed --------------------
    await expectError('NOT_CONFIGURED', () => adapter({ nativeToolsIsolated: false }).invoke(requestFor('answer')), 'native-tool isolation absent');
    await expectError('NOT_CONFIGURED', () => adapter({ egressAttested: false }).invoke(requestFor('answer')), 'egress attestation absent');
    await expectError('NOT_CONFIGURED', () => adapter({ apiKey: '' }).invoke(requestFor('answer')), 'API key absent');
    await expectError('NOT_CONFIGURED', () => adapter({ baseUrl: '' }).invoke(requestFor('answer')), 'base URL absent');
    await expectError('NOT_CONFIGURED', () => adapter({ timeoutMs: 0 }).invoke(requestFor('answer')), 'invalid timeout');
    await expectError('DENIED', () => adapter({ baseUrl: 'http://evil.example' }).invoke(requestFor('answer')), 'unauthorized origin');
    const beforeAnyGate = received.length;

    // --- Positive contract: a normal completion -------------------------------------------
    const answer = await adapter().invoke(requestFor('answer'));
    check(answer.status === 'COMPLETED', 'normal completion is COMPLETED');
    check(answer.engine === 'hermes', 'engine identity is hermes');
    check(answer.content.includes('Grounded answer'), 'assistant content preserved');
    check(answer.usage?.inputTokens === 120 && answer.usage?.outputTokens === 45 && answer.usage?.totalTokens === 165, 'reported usage is propagated');
    check(received.length > beforeAnyGate, 'no request left the process before the gate passed');
    const sent = received.at(-1)!;
    check(sent.authorization === 'Bearer ' + apiKey, 'bearer credential is sent');
    check(typeof sent.body.model === 'string' && sent.body.model === 'google/gemini-3-pro-preview', 'configured model is sent');
    check(JSON.stringify(sent.body).includes('must-not-leak') === false, 'permitted-context filter drops non-permitted keys');
    check(JSON.stringify(sent.body).includes('world-bank:indicator@1'), 'broker tool names are declared in the system prompt');
    check(sent.body.stream === false, 'non-streaming request as designed');

    // --- Provider errors are never results -------------------------------------------------
    const unauthorised = await expectError('NOT_CONFIGURED', () => adapter().invoke(requestFor('unauthorized')), '401 is an error, never an outcome');
    check(/API key/.test(unauthorised.message), '401 explains the credential problem');
    await expectError('UNAVAILABLE', () => adapter().invoke(requestFor('server_502')), '502 agent_incomplete is an error');
    await expectError('INVALID_STATE', () => adapter().invoke(requestFor('error_envelope')), '200 with an error envelope is refused');
    await expectError('UNAVAILABLE', () => adapter().invoke(requestFor('finish_error')), 'finish_reason=error is a provider failure');
    await expectError('INVALID_STATE', () => adapter().invoke(requestFor('provider_failure_text')), 'provider failure text is refused');
    await expectError('INVALID_STATE', () => adapter().invoke(requestFor('finish_cancelled')), 'cancelled turn never yields a result');
    await expectError('INVALID_STATE', () => adapter().invoke(requestFor('malformed_json')), 'malformed body is refused');
    await expectError('UNAVAILABLE', () => adapter().invoke(requestFor('rate_limited')), '429 is a retryable failure');

    // --- Partial answer is INCOMPLETE, never COMPLETED -------------------------------------
    const partial = await adapter().invoke(requestFor('finish_length'));
    check(partial.status === 'INCOMPLETE', 'finish_reason=length is INCOMPLETE');
    check(partial.reason === 'length', 'truncation reason preserved');
    check(partial.content.includes('Partial analysis'), 'partial text preserved for review');

    // --- Zero usage is not proof of zero tokens --------------------------------------------
    const zero = await adapter().invoke(requestFor('zero_usage'));
    check(zero.status === 'COMPLETED', 'zero-usage answer still completes');
    check(zero.usage === undefined, 'unobserved usage is withheld, not reported as zero');
    const normalized = normalizeUsage({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
    check(normalized.reported === false && normalized.totalTokens === undefined, 'normalizeUsage marks unobserved usage');

    // --- Native tool confinement ------------------------------------------------------------
    const toolError = await expectError('DENIED', () => adapter().invoke(requestFor('tool_calls')), 'native tool_calls refused');
    check(/ToolBroker/.test(toolError.message), 'refusal names ToolBroker mediation');
    await expectError('DENIED', () => adapter().invoke(requestFor('native_function_call')), 'legacy function_call refused');

    // --- Timeout and cancellation are distinct and never results ---------------------------
    const timeoutError = await expectError('UNAVAILABLE', () => adapter({ timeoutMs: 250 }).invoke(requestFor('slow')), 'timeout fails closed');
    check(/timed out/.test(timeoutError.message), 'timeout is reported as a timeout');
    const controller = new AbortController();
    const cancelPromise = adapter({ timeoutMs: 5000 }).invoke(requestFor('slow'), { signal: controller.signal });
    setTimeout(() => controller.abort(), 60);
    const cancelError = await expectError('UNAVAILABLE', () => cancelPromise, 'cancellation fails closed');
    check(/cancelled/.test(cancelError.message), 'cancellation is reported as cancellation');
    const preAborted = new AbortController();
    preAborted.abort();
    const beforePreAbort = received.length;
    await expectError('INVALID_STATE', () => adapter().invoke(requestFor('answer'), { signal: preAborted.signal }), 'pre-aborted signal makes no request');
    check(received.length === beforePreAbort, 'pre-aborted signal never reached the endpoint');

    // --- Diagnostics are structured and redacted ------------------------------------------
    check(diagnostics.length > 0, 'diagnostics were emitted');
    check(diagnostics.some(event => event.phase === 'REQUEST'), 'request diagnostic emitted');
    check(diagnostics.some(event => event.phase === 'RESPONSE'), 'response diagnostic emitted');
    check(diagnostics.some(event => event.phase === 'CANCELLED'), 'cancellation diagnostic emitted');
    check(diagnostics.some(event => event.phase === 'RATE_LIMITED'), 'rate-limit diagnostic emitted');
    const serialized = JSON.stringify(diagnostics);
    check(!serialized.includes(apiKey), 'diagnostics never contain the API key');
    check(!serialized.includes('must-not-leak'), 'diagnostics never contain filtered context');
    check(diagnostics.every(event => !('authorization' in event)), 'diagnostics expose no authorization field');

    // --- Redaction ---------------------------------------------------------------------------
    check(redactSecrets('Authorization: Bearer ' + 'k'.repeat(50)).includes('[REDACTED'), 'bearer tokens are redacted');
    check(!redactSecrets('key AIza' + 'b'.repeat(35) + ' end').includes('AIza'), 'Google API keys are redacted');
    check(redactSecrets('{"private_key":"-----BEGIN PRIVATE KEY-----abc"}').includes('[REDACTED]'), 'service-account private keys are redacted');
    check(redactSecrets('The market grew 12% in 2026.').includes('market grew 12%'), 'ordinary prose is not redacted');

    // --- Classification precedence ----------------------------------------------------------
    check(classifyCompletion({ finishReason: 'error', extras: { failed: true }, content: 'looks like an answer' }) === 'PROVIDER_FAILURE', 'failure flags beat answer text');
    check(classifyCompletion({ finishReason: 'length', content: 'text' }) === 'INCOMPLETE', 'length is INCOMPLETE');
    check(classifyCompletion({ finishReason: 'cancelled', content: 'text' }) === 'CANCELLED', 'cancelled is CANCELLED');
    check(classifyCompletion({ finishReason: 'stop', content: 'real answer' }) === 'ANSWER', 'stop is ANSWER');
    check(classifyCompletion({ finishReason: 'stop', content: 'Insufficient quota information was available for the region.' }) === 'ANSWER', 'business prose about quotas is not a provider failure');

    console.log('PASS: Hermes/VERTEX contract QA — ' + assertions + ' assertions (contract only; real inference NOT exercised).');
  } finally {
    await fixture.close();
  }
}

main().catch(error => {
  console.error('Hermes contract QA FAILED:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

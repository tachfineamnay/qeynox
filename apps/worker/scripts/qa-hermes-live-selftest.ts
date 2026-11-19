/**
 * Self-test for the live inference procedure (`qa-hermes-live.ts`).
 *
 * It starts a local deterministic fixture that speaks the documented Hermes API-server surface and
 * runs the live script against it. This proves the PROCEDURE, the exit codes and the redaction.
 * It is explicitly NOT evidence of real inference: the fixture is a test harness, and the script
 * prints its own limits. Real inference requires an operator-supplied deployment and credentials.
 *
 * Run: npx tsx apps/worker/scripts/qa-hermes-live-selftest.ts
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const KEY = 'qa-self-test-key-' + 'q'.repeat(48);
let assertions = 0;
function check(condition: unknown, message: string): asserts condition {
  assertions++;
  if (!condition) throw new Error('ASSERTION FAILED: ' + message);
}

const server = createServer((request, response) => {
  let raw = '';
  request.on('data', chunk => { raw += String(chunk); });
  request.on('end', () => {
    response.setHeader('content-type', 'application/json');
    const authorized = request.headers.authorization === 'Bearer ' + KEY;
    if (request.url === '/health' || request.url === '/v1/health') {
      response.end(JSON.stringify({ status: 'ok', platform: 'hermes-agent', version: 'self-test-0.0.0' }));
      return;
    }
    if (!authorized) {
      response.statusCode = 401;
      response.end(JSON.stringify({ error: { message: 'Invalid gateway API key (API_SERVER_KEY)', type: 'gateway_auth_error', code: 'gateway_auth_failed' } }));
      return;
    }
    if (request.url === '/v1/models') {
      response.end(JSON.stringify({ object: 'list', data: [{ id: 'vertex/gemini-3-pro-preview', object: 'model' }] }));
      return;
    }
    if (request.url === '/v1/toolsets') {
      response.end(JSON.stringify({
        object: 'list', platform: 'api_server',
        data: [
          { name: 'web', enabled: false, configured: true, tools: ['web_search'] },
          { name: 'terminal', enabled: false, configured: true, tools: ['shell'] },
        ],
      }));
      return;
    }
    if (request.url === '/v1/chat/completions' && request.method === 'POST') {
      response.end(JSON.stringify({
        id: 'chatcmpl-self-test', object: 'chat.completion', created: 1, model: 'vertex/gemini-3-pro-preview',
        choices: [{ index: 0, message: { role: 'assistant', content: 'A Vertex AI service account is a Google Cloud identity used by workloads to authenticate to Vertex AI.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 42, completion_tokens: 18, total_tokens: 60 },
      }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: { message: 'not found' } }));
  });
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const port = (server.address() as AddressInfo).port;
const url = 'http://127.0.0.1:' + port + '/v1/';

async function runLive(env: Record<string, string>): Promise<{ code: number | null; stdout: string }> {
  const child = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'apps/worker/scripts/qa-hermes-live.ts'], {
    cwd: fileURLToPath(new URL('../../..', import.meta.url)),
    env: { ...process.env, QEYNOX_QA_HERMES_URL: '', QEYNOX_QA_HERMES_KEY: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  child.stdout.on('data', chunk => { stdout += String(chunk); });
  child.stderr.on('data', chunk => { stdout += String(chunk); });
  const [code] = await once(child, 'exit') as [number | null];
  return { code, stdout };
}

let serverIsolationOff: ReturnType<typeof createServer> | undefined;
try {
  // 1. No credentials -> BLOCKED (exit 3), never a pass.
  const missing = await runLive({});
  check(missing.code === 3, 'missing credentials exit BLOCKED (3), got ' + missing.code);
  check(/BLOCKED/.test(missing.stdout), 'blocked run says BLOCKED');
  check(!/^PASS/m.test(missing.stdout), 'blocked run never reports PASS');

  // 2. Wrong key -> not a pass.
  const wrong = await runLive({ QEYNOX_QA_HERMES_URL: url, QEYNOX_QA_HERMES_KEY: 'wrong-key-' + 'z'.repeat(40) });
  check(wrong.code === 3, 'unauthenticated deployment exit BLOCKED (3), got ' + wrong.code);
  check(!/^PASS/m.test(wrong.stdout), 'unauthenticated run never reports PASS');

  // 3. Valid key but isolation not evidenced -> BLOCKED unless explicitly allowed.
  const unattested = await runLive({ QEYNOX_QA_HERMES_URL: url, QEYNOX_QA_HERMES_KEY: KEY, QEYNOX_QA_HERMES_MODEL: 'vertex/gemini-3-pro-preview' });
  check(unattested.code === 0, 'evidenced isolation (no enabled toolset) allows the run, got ' + unattested.code);
  check(/^PASS: real inference verified/m.test(unattested.stdout), 'run reports a real-inference pass');
  check(/native tools isolated: true/.test(unattested.stdout), 'toolset isolation is evidenced');
  check(/in=42 out=18 total=60/.test(unattested.stdout), 'reported usage is shown');
  check(!unattested.stdout.includes(KEY), 'the API key never appears in the output');

  // 4. An explicit unattested opt-in is reported as inference-only, never as isolation proof.
  serverIsolationOff = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/health') { response.end(JSON.stringify({ status: 'ok', platform: 'hermes-agent', version: 'self-test' })); return; }
    if (request.headers.authorization !== 'Bearer ' + KEY) {
      response.statusCode = 401;
      response.end(JSON.stringify({ error: { message: 'invalid', type: 'gateway_auth_error', code: 'gateway_auth_failed' } }));
      return;
    }
    if (request.url === '/v1/models') { response.end(JSON.stringify({ data: [{ id: 'vertex/gemini-3-pro-preview' }] })); return; }
    if (request.url === '/v1/toolsets') {
      response.end(JSON.stringify({ data: [{ name: 'web', enabled: true, configured: true, tools: ['web_search'] }] }));
      return;
    }
    response.end(JSON.stringify({
      id: 'chatcmpl-leaky', choices: [{ message: { content: 'Answer.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
  });
  serverIsolationOff.listen(0, '127.0.0.1');
  await once(serverIsolationOff, 'listening');
  const leakyUrl = 'http://127.0.0.1:' + (serverIsolationOff.address() as AddressInfo).port + '/v1/';
  const blockedByTools = await runLive({ QEYNOX_QA_HERMES_URL: leakyUrl, QEYNOX_QA_HERMES_KEY: KEY });
  check(blockedByTools.code === 3, 'enabled toolsets block the run (exit 3), got ' + blockedByTools.code);
  check(/native-tool isolation is not evidenced/.test(blockedByTools.stdout), 'block explains the isolation gap');

  const optedIn = await runLive({
    QEYNOX_QA_HERMES_URL: leakyUrl, QEYNOX_QA_HERMES_KEY: KEY, QEYNOX_QA_ALLOW_UNATTESTED: 'true',
  });
  check(optedIn.code === 0, 'explicit unattested opt-in runs the probe, got ' + optedIn.code);
  check(/Native-tool isolation: UNPROVEN/.test(optedIn.stdout), 'unproven isolation is stated, never assumed');
  check(/enabled toolsets\s+: web/.test(optedIn.stdout), 'the enabled toolset is named');

  console.log('PASS: live-inference procedure self-test — ' + assertions + ' assertions.');
  console.log('This validates the procedure and exit codes against a fixture. It is NOT real inference evidence.');
} finally {
  server.close();
  server.closeAllConnections();
  serverIsolationOff?.close();
  serverIsolationOff?.closeAllConnections();
}

/**
 * FAST LIVE targeted check: Worker -> real Hermes (no fixture, no database).
 *
 * Requires a reachable Hermes API server: QEYNOX_QA_HERMES_URL and QEYNOX_QA_HERMES_KEY.
 * The isolation flags below are TEST INPUTS that only exercise the adapter contract; they
 * are not an operational attestation and never enable tenant execution.
 * Non-destructive: two tiny completion requests, one refused connection, no mission row.
 */
import { HermesAdapter } from '@qeynox/engine';
import { DomainError, type ID } from '@qeynox/domain';

const url = process.env.QEYNOX_QA_HERMES_URL;
const key = process.env.QEYNOX_QA_HERMES_KEY;
if (!url || !key) {
  console.log('NOT_RUN: QEYNOX_QA_HERMES_URL / QEYNOX_QA_HERMES_KEY are not set');
  process.exit(0);
}

let assertions = 0;
function assert(condition: unknown, message: string): asserts condition {
  assertions++;
  if (!condition) throw new Error('ASSERTION FAILED: ' + message);
}
async function expectDomainError(run: () => Promise<unknown>, code: string, label: string): Promise<void> {
  assertions++;
  try {
    await run();
  } catch (error: unknown) {
    if (error instanceof DomainError && error.code === code) return;
    throw new Error('EXPECTED ' + code + ' for ' + label + ', got ' + (error instanceof DomainError ? error.code : String(error)));
  }
  throw new Error('EXPECTED ' + code + ' for ' + label + ', but no error was raised');
}

const profile = {
  id: 'qa-profile' as ID, role: 'business' as const, version: 1, title: 'QA',
  systemInstructions: 'QA contract check.',
  skillRefs: [] as const, allowedTools: ['world-bank:indicator@1'] as const,
  permittedContextKeys: ['operationTitle'] as const, maxOutputTokens: 32, maxIterations: 1,
};
const request = {
  workspaceId: 'qa-workspace' as ID, operationId: 'qa-operation' as ID, stepAttemptId: 'qa-attempt' as ID,
  profile, userMessage: 'ping', context: { operationTitle: 'ping' }, correlationId: 'qa-hermes-live',
};

// The key must be enforced by the server: a refused credential is an error, never an outcome.
await expectDomainError(
  () => new HermesAdapter({ baseUrl: url, apiKey: 'qa-definitely-wrong-key', model: 'hermes-agent', timeoutMs: 20000, nativeToolsIsolated: true, egressAttested: true }).invoke(request),
  'INVALID_STATE', 'wrong API key is rejected as an error',
);

// An unreachable endpoint must throw; it can never produce an EngineOutcome.
assertions++;
let unreachableThrew = false;
try {
  await new HermesAdapter({ baseUrl: 'http://127.0.0.1:1/v1/', apiKey: key, model: 'hermes-agent', timeoutMs: 5000, nativeToolsIsolated: true, egressAttested: true }).invoke(request);
} catch { unreachableThrew = true; }
assert(unreachableThrew, 'unreachable Hermes endpoint never yields an outcome');

// With a valid key: either a normal completion, or the documented provider failure must fail closed.
const adapter = new HermesAdapter({ baseUrl: url, apiKey: key, model: 'hermes-agent', timeoutMs: 30000, nativeToolsIsolated: true, egressAttested: true });
try {
  const outcome = await adapter.invoke(request);
  assert(outcome.status === 'COMPLETED' || outcome.status === 'INCOMPLETE', 'configured provider yields a normal outcome');
  assert(!/provider authentication failed|no inference provider configured/i.test(outcome.content), 'provider failure text is never returned as agent content');
  console.log('Configured inference provider accepted the request.');
} catch (error: unknown) {
  const code = error instanceof DomainError ? error.code : 'RAW_ERROR';
  if (code === 'INVALID_STATE' && /no usable inference provider/.test(String((error as Error).message))) {
    console.log('No inference provider configured: adapter failed closed (expected here).');
  } else if (code === 'DENIED' && /native tool call/.test(String((error as Error).message))) {
    console.log('Native tool call rejected: ToolBroker mediation enforced.');
  } else {
    throw error;
  }
}
console.log('Hermes live contract PASSED:', assertions, 'assertions');

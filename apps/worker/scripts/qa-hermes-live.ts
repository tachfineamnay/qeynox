/**
 * MISSION A02 — mandatory POSITIVE real-inference test (worker -> real Hermes -> Vertex/Gemini).
 *
 * This is the only test that can prove real inference. It is separate from the isolated
 * security-contract suite (`packages/engine/scripts/qa-hermes-contract.ts`), which can never
 * prove a provider is reachable.
 *
 * Exit status contract (a blocked run is never reported as a pass):
 *   0  PASS        a real completion came back from the configured provider
 *   3  BLOCKED     credentials or endpoint not supplied, or the deployment reports no provider
 *   1  FAILED      the contract was violated (provider error disguised as success, native tool
 *                  call, wrong-credential acceptance, malformed body ...)
 *
 * Required operator input (never committed, never echoed):
 *   QEYNOX_QA_HERMES_URL   private endpoint, e.g. http://qeynox-hermes:8642/v1/ (use an SSH tunnel
 *                          for a remote deployment; the API server is never exposed publicly)
 *   QEYNOX_QA_HERMES_KEY   the deployment's API_SERVER_KEY
 * Optional:
 *   QEYNOX_QA_HERMES_MODEL     model id or alias Hermes routes to Vertex/Gemini
 *                              (default: HERMES_MODEL, else whatever /v1/models advertises)
 *   QEYNOX_QA_HERMES_TIMEOUT_MS default 60000 (Gemini 3.x thinking models can be slow)
 *   QEYNOX_QA_HERMES_PROMPT    the real prompt to send (default: a short deterministic one)
 *   QEYNOX_QA_ALLOW_UNATTESTED=true  run the inference probe WITHOUT claiming isolation.
 *                              The inference proof stands; isolation stays unproven and is
 *                              reported that way.
 *
 * What it does NOT do: it does not set HERMES_NATIVE_TOOLS_ISOLATED, does not mark the runtime
 * verified (since A21.07 only the API/worker runtime probes can), and does not create a mission or
 * touch any database.
 */
import { HermesAdapter, probeHermes, redactSecrets, type HermesDiagnostic } from '@qeynox/engine';
import { DomainError, type ID } from '@qeynox/domain';

const PASS = 0;
const FAILED = 1;
const BLOCKED = 3;

const url = (process.env.QEYNOX_QA_HERMES_URL ?? '').trim();
const key = (process.env.QEYNOX_QA_HERMES_KEY ?? '').trim();
const timeoutMs = Number(process.env.QEYNOX_QA_HERMES_TIMEOUT_MS ?? 60000);
const allowUnattested = process.env.QEYNOX_QA_ALLOW_UNATTESTED === 'true';
const prompt = (process.env.QEYNOX_QA_HERMES_PROMPT ?? '').trim()
  || 'Reply with exactly one short sentence describing what a Vertex AI service account is. No preamble.';

let assertions = 0;
function assert(condition: unknown, message: string): asserts condition {
  assertions++;
  if (!condition) throw new Error('ASSERTION FAILED: ' + message);
}
function blocked(reason: string): never {
  console.log('BLOCKED: ' + reason);
  process.exit(BLOCKED);
}

if (!url || !key) {
  blocked('real inference not attempted: QEYNOX_QA_HERMES_URL / QEYNOX_QA_HERMES_KEY are not set. '
    + 'A contract-only run is NOT evidence of real inference.');
}
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) blocked('QEYNOX_QA_HERMES_TIMEOUT_MS must be a positive number');

const profile = {
  id: 'qa-profile' as ID, role: 'business' as const, version: 1, title: 'QA live inference',
  systemInstructions: 'You are answering a deployment verification prompt. Answer in one sentence.',
  skillRefs: [] as const, allowedTools: [] as const,
  permittedContextKeys: ['operationTitle'] as const, maxOutputTokens: 256, maxIterations: 1,
};

async function main(): Promise<void> {
  // --- Step 1: read the deployment's own facts before asserting anything -------------------
  const report = await probeHermes({ baseUrl: url, apiKey: key, timeoutMs: Math.min(timeoutMs, 15000) });
  console.log('deployment diagnostics (redacted):');
  console.log('  endpoint origin      : ' + (report.endpointOrigin ?? 'unavailable'));
  console.log('  reachable            : ' + String(report.reachable));
  console.log('  runtime version      : ' + (report.runtimeVersion ?? 'not reported'));
  console.log('  authenticated        : ' + String(report.authenticated));
  console.log('  advertised models    : ' + (report.models ? report.models.join(', ') || '(none)' : 'unavailable'));
  console.log('  native tools isolated: ' + (report.nativeToolsIsolated === null ? 'UNKNOWN (inventory unreadable)' : String(report.nativeToolsIsolated)));
  if (report.failures.length) console.log('  diagnostics failures : ' + report.failures.join(' | '));
  if (report.toolsets) {
    const enabled = report.toolsets.filter(toolset => toolset.enabled).map(toolset => toolset.name);
    console.log('  enabled toolsets     : ' + (enabled.length ? enabled.join(', ') : '(none)'));
  }

  // An unreachable deployment or a rejected key is a deployment blocker, not a contract violation.
  if (!report.reachable) {
    blocked('real inference not attempted: the Hermes endpoint is unreachable ('
      + report.failures.join(' | ') + '). Nothing about provider usability is proven.');
  }
  if (!report.authenticated) {
    blocked('real inference not attempted: the supplied API key did not authenticate ('
      + report.failures.join(' | ') + '). Check HERMES_API_KEY / API_SERVER_KEY.');
  }

  const model = (process.env.QEYNOX_QA_HERMES_MODEL ?? process.env.HERMES_MODEL ?? report.models?.[0] ?? '').trim();
  if (!model) blocked('the deployment advertises no model and QEYNOX_QA_HERMES_MODEL is not set');

  // Isolation is evidence, not an assumption. Without it we may still prove inference, but the
  // run is reported as an inference proof only.
  const isolationEvidenced = report.nativeToolsIsolated === true;
  if (!isolationEvidenced && !allowUnattested) {
    blocked('native-tool isolation is not evidenced (GET /v1/toolsets must report no enabled toolset). '
      + 'Apply platform_toolsets.api_server: [] and re-run, or set QEYNOX_QA_ALLOW_UNATTESTED=true '
      + 'to prove inference only. Isolation remains UNPROVEN either way.');
  }

  // --- Step 2: the provider must reject a wrong credential ---------------------------------
  // A deployment that accepts an arbitrary key has no authentication; that is a failure.
  const wrongKey = 'qa-definitely-wrong-' + 'x'.repeat(32);
  let wrongKeyRejected = false;
  try {
    await new HermesAdapter({ baseUrl: url, apiKey: wrongKey, model, timeoutMs: 15000, nativeToolsIsolated: true, egressAttested: true })
      .invoke(request('wrong-key'));
  } catch (error: unknown) {
    wrongKeyRejected = error instanceof DomainError && error.code === 'NOT_CONFIGURED' && /API key/.test(error.message);
    if (!wrongKeyRejected) throw error;
  }
  assert(wrongKeyRejected, 'the deployment must reject an invalid API key');
  console.log('wrong credential rejected: yes');

  // --- Step 3: POSITIVE real inference -----------------------------------------------------
  const diagnostics: HermesDiagnostic[] = [];
  const adapter = new HermesAdapter({
    baseUrl: url, apiKey: key, model, timeoutMs,
    // These are TEST INPUTS that only satisfy the adapter gate; they are not an operational
    // attestation and this script never records one.
    nativeToolsIsolated: true, egressAttested: true,
    onDiagnostic: event => diagnostics.push(event),
  });
  const started = Date.now();
  let outcome;
  try {
    outcome = await adapter.invoke(request('positive'));
  } catch (error: unknown) {
    const code = error instanceof DomainError ? error.code : 'RAW_ERROR';
    const message = error instanceof Error ? redactSecrets(error.message, 300) : 'unknown';
    if (code === 'UNAVAILABLE' || code === 'NOT_CONFIGURED') {
      blocked('real inference did not run: Hermes reported ' + code + ' (' + message + '). '
        + 'The provider is not usable in this deployment; this is a deployment blocker, not a pass.');
    }
    throw error;
  }
  const elapsed = Date.now() - started;

  assert(outcome.status === 'COMPLETED' || outcome.status === 'INCOMPLETE', 'a real provider answered');
  assert(outcome.content.trim().length > 0, 'the answer carries text');
  // Provider errors disguised as success are the failure mode this mission exists to prevent.
  assert(!/provider authentication failed|no inference provider configured|no inference provider available/i.test(outcome.content), 'the answer is not a rendered provider failure');
  assert(outcome.proposedTools.length === 0, 'no unmediated tool action was proposed');
  assert(diagnostics.every(event => !JSON.stringify(event).includes(key)), 'diagnostics never contain the API key');

  console.log('real inference: PASS');
  console.log('  model           : ' + model);
  console.log('  engine run id   : ' + (outcome.engineRunId ?? 'not reported'));
  console.log('  status          : ' + outcome.status);
  console.log('  finish reason   : ' + (outcome.reason ?? 'not reported'));
  console.log('  latency ms      : ' + elapsed);
  console.log('  usage           : ' + (outcome.usage
    ? 'in=' + (outcome.usage.inputTokens ?? '?') + ' out=' + (outcome.usage.outputTokens ?? '?') + ' total=' + (outcome.usage.totalTokens ?? '?')
    : 'not observed by the runtime (reported as unknown, never as zero)'));
  console.log('  answer (first 200 chars): ' + redactSecrets(outcome.content.trim(), 200));
  console.log('');
  console.log('LIMITS OF THIS PROOF');
  console.log('  · Inference through Hermes to the configured provider: PROVEN for this deployment.');
  console.log('  · Native-tool isolation: ' + (isolationEvidenced ? 'evidenced by /v1/toolsets (enabled: none)' : 'UNPROVEN (no toolset inventory attestation)'));
  console.log('  · Server-side cancellation: not observable for non-streaming chat completions; client-side only.');
  console.log('  · This script does not mark the runtime verified (A21.07: only the API/worker live probes do) and does not touch any database.');
  console.log('PASS: real inference verified — ' + assertions + ' assertions, ' + elapsed + 'ms.');
}

function request(label: string) {
  return {
    workspaceId: 'qa-workspace' as ID, operationId: 'qa-operation' as ID, stepAttemptId: 'qa-attempt' as ID,
    profile, userMessage: prompt, context: { operationTitle: 'QeyNox inference verification (' + label + ')' },
    correlationId: 'qa-hermes-live-' + label + '-' + Date.now(),
  };
}

main().then(
  () => { process.exit(PASS); },
  (error: unknown) => {
    console.error('FAILED: ' + (error instanceof Error ? redactSecrets(error.message, 500) : String(error)));
    process.exit(FAILED);
  },
);

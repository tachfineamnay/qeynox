/**
 * Safe runtime diagnostics for the Hermes -> Vertex/Gemini arrangement.
 *
 * Reads only what the deployment reports: no credentials are printed, no attestation is set and
 * no inference is performed. Exit codes: 0 healthy, 3 blocked (configuration or deployment gap),
 * 1 unexpected failure.
 *
 * Run inside the worker/API container (the endpoint is private):
 *   HERMES_API_BASE_URL=http://qeynox-hermes:8642/v1/ HERMES_API_KEY=... pnpm hermes:diagnose
 */
import { describeInferenceBlockers, probeHermes, redactSecrets } from '@qeynox/engine';

const baseUrl = process.env.HERMES_API_BASE_URL;
const apiKey = process.env.HERMES_API_KEY;
const model = process.env.HERMES_MODEL;
const privateOrigin = process.env.HERMES_PRIVATE_ORIGIN;
const nativeToolsIsolated = process.env.HERMES_NATIVE_TOOLS_ISOLATED === 'true';
const egressAttested = process.env.QEYNOX_NETWORK_POLICY_ATTESTED === 'true';

const blockers = describeInferenceBlockers({ baseUrl, apiKey, nativeToolsIsolated, egressAttested });

async function main(): Promise<number> {
  console.log('QeyNox -> Hermes diagnostics (no credentials are printed)');
  console.log('  configured model      : ' + (model ?? 'not set (Hermes default applies)'));
  console.log('  provider hint         : ' + (process.env.HERMES_PROVIDER ?? 'not set (Hermes resolves it)'));
  console.log('  private origin        : ' + (privateOrigin ? 'set' : 'not set'));
  console.log('  isolation attestation : ' + (nativeToolsIsolated ? 'set (operator claim, not proof)' : 'NOT set'));
  console.log('  egress attestation    : ' + (egressAttested ? 'set (operator claim, not proof)' : 'NOT set'));
  // A21.07: live verification is decided by the API/worker probes at runtime, never by a switch.
  console.log('  runtime verification  : decided by live probes in the API and worker (no environment switch)');
  console.log('');

  if (!baseUrl) {
    console.log('Configuration blockers: ' + blockers.join(', '));
    console.log('BLOCKED: no Hermes endpoint is configured for this process.');
    return 3;
  }

  const report = await probeHermes({ baseUrl, apiKey, privateOrigin, model, timeoutMs: 10000 });
  console.log('Deployment facts');
  console.log('  reachable          : ' + String(report.reachable));
  console.log('  endpoint origin    : ' + (report.endpointOrigin ?? 'unauthorized'));
  console.log('  platform / version : ' + (report.platform ?? '?') + ' / ' + (report.runtimeVersion ?? 'not reported'));
  console.log('  authenticated      : ' + String(report.authenticated));
  console.log('  advertised models  : ' + (report.models ? (report.models.join(', ') || '(none)') : 'unavailable'));
  console.log('  configured model advertised: ' + (report.activeModelAdvertised === null ? 'unknown' : String(report.activeModelAdvertised)));
  console.log('  native tools       : ' + (report.nativeToolsIsolated === null
    ? 'UNKNOWN — the toolset inventory could not be read (isolation is NOT evidenced)'
    : report.nativeToolsIsolated ? 'no toolset enabled (isolation evidenced by /v1/toolsets)' : 'ENABLED TOOLSETS PRESENT — unsafe for tenant data'));
  if (report.toolsets) {
    for (const toolset of report.toolsets.filter(entry => entry.enabled)) {
      console.log('    enabled: ' + toolset.name + ' (' + toolset.toolCount + ' tools)');
    }
  }
  for (const failure of report.failures) console.log('  failure            : ' + redactSecrets(failure, 200));

  console.log('');
  if (blockers.length) console.log('Configuration blockers: ' + blockers.join(', '));
  const operational = report.reachable && report.authenticated && report.nativeToolsIsolated === true && blockers.length === 0;
  if (!operational) {
    console.log('BLOCKED: the deployment is not ready for tenant inference. No attestation was set by this command.');
    return 3;
  }
  console.log('Runtime prerequisites are configured and isolation is evidenced. Real inference is still');
  console.log('unproven until `pnpm qa:hermes-live` returns PASS with operator credentials.');
  return 0;
}

main().then(
  code => { process.exitCode = code; },
  (error: unknown) => {
    console.error('FAILED: ' + redactSecrets(error instanceof Error ? error.message : String(error), 300));
    process.exitCode = 1;
  },
);

import { hermesEndpoint } from '@qeynox/engine';
import type { RuntimeReadiness } from '@qeynox/application';

/**
 * Reads the deployment prerequisites required to execute a mission step.
 *
 * - Hermes is the replaceable intelligence runtime; it fails closed without its endpoint, API key,
 *   native-tool isolation and tested egress containment.
 * - Hatchet is the single durable workflow executor; the outbox dispatcher cannot run without a
 *   client token.
 *
 * Missing values are reported by name. Nothing is reported as configured without evidence.
 */
export function apiRuntimeReadiness(): RuntimeReadiness {
  const missing: string[] = [];
  const baseUrl = (process.env.HERMES_API_BASE_URL ?? '').trim();
  const apiKey = (process.env.HERMES_API_KEY ?? '').trim();
  if (!baseUrl) missing.push('HERMES_API_BASE_URL');
  else {
    try { hermesEndpoint(baseUrl, process.env.HERMES_PRIVATE_ORIGIN); }
    catch { missing.push('HERMES_API_BASE_URL (origin not authorized: use https, a local host or HERMES_PRIVATE_ORIGIN)'); }
  }
  if (!apiKey) missing.push('HERMES_API_KEY');
  if (process.env.HERMES_NATIVE_TOOLS_ISOLATED !== 'true') missing.push('HERMES_NATIVE_TOOLS_ISOLATED=true');
  if (process.env.QEYNOX_NETWORK_POLICY_ATTESTED !== 'true') missing.push('QEYNOX_NETWORK_POLICY_ATTESTED=true');
  const hatchetConfigured = (process.env.HATCHET_CLIENT_TOKEN ?? '').trim().length > 0;
  return {
    engine: { id: 'hermes', configured: missing.length === 0, missing },
    orchestrator: { id: 'hatchet', configured: hatchetConfigured, missing: hatchetConfigured ? [] : ['HATCHET_CLIENT_TOKEN'] },
  };
}

import { DomainError } from '@qeynox/domain';
import type { HermesConfig } from './hermes';

export const HERMES_MAX_REQUEST_TIMEOUT_MS = 120_000;
export function validHermesTimeout(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 250 && value <= HERMES_MAX_REQUEST_TIMEOUT_MS;
}
/** Vertex uses the google/ vendor prefix, not the AI Studio gemini/ route. No default model guess. */
export function validVertexModel(value: string): boolean {
  return /^google\/gemini-[a-z0-9][a-z0-9.-]{0,119}$/.test(value);
}
export function hermesSettingsFromEnv(env: NodeJS.ProcessEnv): HermesConfig {
  const provider = env.HERMES_PROVIDER?.trim();
  if (provider && !['vertex', 'gemini', 'custom'].includes(provider)) throw new DomainError('NOT_CONFIGURED', 'Unsupported HERMES_PROVIDER');
  return {
    baseUrl: env.HERMES_API_BASE_URL, privateOrigin: env.HERMES_PRIVATE_ORIGIN, apiKey: env.HERMES_API_KEY,
    model: env.HERMES_MODEL?.trim() || (provider === 'vertex' ? '' : 'hermes-agent'),
    provider: provider === 'vertex' || provider === 'gemini' || provider === 'custom' ? provider : undefined,
    timeoutMs: Number(env.HERMES_REQUEST_TIMEOUT_MS ?? 60_000),
    nativeToolsIsolated: env.HERMES_NATIVE_TOOLS_ISOLATED === 'true',
    egressAttested: env.QEYNOX_NETWORK_POLICY_ATTESTED === 'true',
  };
}

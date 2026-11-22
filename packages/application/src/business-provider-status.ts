import { resolveConfiguredProviders, worldBankManifest, braveSearchManifest } from '@qeynox/tools';
import type { QeyNoxStore } from '@qeynox/persistence';
import { REQUIRED_PROVIDER_BY_PACK, UNAVAILABLE_CONNECTORS_BY_PACK, requiredToolForPack } from './business-packs';
import type { BusinessPackDomain } from '@qeynox/contracts';

/** Configuration inspection only. No external request, secret/reference value, token refresh or write. */
export async function businessProviderStatus(store: QeyNoxStore) {
  const { providers, registry } = await resolveConfiguredProviders(store.db);
  return {
    checkedAt: new Date().toISOString(),
    providers: providers.map(provider => {
      const manifest = provider.connectorId === 'world-bank' ? worldBankManifest : provider.connectorId === 'brave-search' ? braveSearchManifest : undefined;
      return { ...provider, mode: manifest?.mode ?? null, termsUrl: manifest?.termsUrl ?? null,
        licenseNotes: manifest?.licenseNotes ?? null, freshness: manifest?.freshness ?? null,
        configuredMaxPerMinute: provider.state === 'CONFIGURED_NOT_LIVE_VERIFIED' ? registry.manifest(provider.connectorId).rateLimit.maxPerMinute : null };
    }),
    packs: (Object.keys(REQUIRED_PROVIDER_BY_PACK) as BusinessPackDomain[]).map(pack => ({
      pack, requiredProvider: REQUIRED_PROVIDER_BY_PACK[pack], requiredTool: requiredToolForPack(pack),
      providerStatus: providers.find(provider => provider.connectorId === REQUIRED_PROVIDER_BY_PACK[pack])?.state ?? 'BLOCKED',
      unavailableExternalConnectors: UNAVAILABLE_CONNECTORS_BY_PACK[pack],
    })),
    boundary: 'Configuration only, not live provider/credential/licence/egress certification. Workspace consent, capability/profile, verification policy and finite operation/beta spend reservations are still required. OAuth identity connections do not activate business tools. No external WRITE adapter is registered.',
  };
}

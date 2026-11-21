import { readFileSync } from 'node:fs';
import { Module } from '@nestjs/common';
import { QeyNoxStore } from '@qeynox/persistence';
import {
  PlanningService,
  ServiceCatalogueService,
  ServiceContractRegistry,
  createContractsFromCatalogJson,
  type DeploymentProbe,
  type ServiceRequestContract,
} from '@qeynox/application';
import { SERVICE_CONTRACT_WORLD_BANK as WB_KEY } from '@qeynox/contracts';
import { QEYNOX_STORE } from '../database/database.module';
import { apiRuntimeReadiness } from '../operations/runtime-readiness';
import { ServicesController } from './services.controller';
import { SERVICES_CATALOGUE, SERVICES_CONTRACTS } from './services.tokens';

/**
 * MISSION A13 + A16 — service catalogue and business capability packs wiring.
 *
 * Typed request contracts are loaded from the operator service configuration file(s) named by
 * QEYNOX_SERVICE_CATALOG_PATH (for example infra/operator/a16-business-packs.json, an individual pack
 * under infra/operator/packs/*.json, infra/operator/a03-economic-research.json, or a comma-separated
 * list of files). When unset, unreadable or invalid, contracts fail closed to null: published offers
 * remain visible with their real availability, and ordering fails closed with SERVICE_NOT_CONFIGURED.
 */

export const QEYNOX_SERVICE_CATALOG_PATH = 'QEYNOX_SERVICE_CATALOG_PATH';

function buildContracts(store: QeyNoxStore): ServiceContractRegistry | null {
  const rawPaths = (process.env[QEYNOX_SERVICE_CATALOG_PATH] ?? '').trim();
  if (!rawPaths) {
    console.log('[services] QEYNOX_SERVICE_CATALOG_PATH is not set; offers are listed but no request contract is registered');
    return null;
  }
  const paths = rawPaths.split(',').map(p => p.trim()).filter(Boolean);
  if (paths.length === 0) return null;
  try {
    const planning = new PlanningService(store);
    const allContracts: ServiceRequestContract[] = [];
    for (const filePath of paths) {
      const parsedJson = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
      allContracts.push(...createContractsFromCatalogJson(store, planning, parsedJson, apiRuntimeReadiness));
    }
    const registry = new ServiceContractRegistry(allContracts);
    console.log(
      '[services] registered ' + String(allContracts.length) + ' service contract(s): ' +
      registry.registeredOfferIds().join(', '),
    );
    return registry;
  } catch (error: unknown) {
    // Fail closed: a malformed service definition never becomes a callable contract.
    console.error('[services] service catalog not configured:', error instanceof Error ? error.message : 'unknown error');
    return null;
  }
}

function createDeploymentProbe(contracts: ServiceContractRegistry | null): DeploymentProbe {
  return (contractKey, offerId) => {
    const worldBankEnabled = process.env.QEYNOX_WORLD_BANK_ENABLED === 'true';
    const braveSearchEnabled = process.env.QEYNOX_BRAVE_SEARCH_ENABLED === 'true';
    const braveSearchKeyConfigured = Boolean((process.env.QEYNOX_BRAVE_SEARCH_API_KEY ?? '').trim());
    const egressAttested = process.env.QEYNOX_NETWORK_POLICY_ATTESTED === 'true';

    const contract = (offerId ? contracts?.forOffer(offerId) : null) ?? contracts?.forKey(contractKey) ?? null;
    if (contractKey === WB_KEY && !contract) {
      return {
        worldBankEnabled,
        egressAttested,
        braveSearchEnabled,
        braveSearchKeyConfigured,
        requiredProvider: 'world-bank',
        providerSwitchReady: worldBankEnabled && egressAttested,
        consentScopesRequired: [],
        unavailableExternalConnectors: [],
      };
    }
    if (!contract) return null;

    const requiredProvider = contract.requiredProvider ?? 'world-bank';
    const providerSwitchReady = requiredProvider === 'brave-search'
      ? braveSearchEnabled && braveSearchKeyConfigured && egressAttested
      : worldBankEnabled && egressAttested;
    const consentScopesRequired = requiredProvider === 'brave-search' ? ['web:search'] : [];

    return {
      worldBankEnabled,
      egressAttested,
      braveSearchEnabled,
      braveSearchKeyConfigured,
      requiredProvider,
      providerSwitchReady,
      consentScopesRequired,
      unavailableExternalConnectors: [...(contract.unavailableExternalConnectors ?? [])],
    };
  };
}

@Module({
  controllers: [ServicesController],
  providers: [
    { provide: SERVICES_CONTRACTS, useFactory: (store: QeyNoxStore) => buildContracts(store), inject: [QEYNOX_STORE] },
    {
      provide: SERVICES_CATALOGUE,
      useFactory: (store: QeyNoxStore, contracts: ServiceContractRegistry | null) =>
        new ServiceCatalogueService(store, apiRuntimeReadiness, contracts, createDeploymentProbe(contracts)),
      inject: [QEYNOX_STORE, SERVICES_CONTRACTS],
    },
  ],
})
export class ServicesModule {}

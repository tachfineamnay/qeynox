import { readFileSync } from 'node:fs';
import { Module } from '@nestjs/common';
import { QeyNoxStore } from '@qeynox/persistence';
import {
  PlanningService,
  ServiceCatalogueService,
  ServiceContractRegistry,
  WorldBankResearchContract,
  parseWorldBankServiceConfig,
  type DeploymentProbe,
} from '@qeynox/application';
import { SERVICE_CONTRACT_WORLD_BANK as WB_KEY } from '@qeynox/contracts';
import { QEYNOX_STORE } from '../database/database.module';
import { apiRuntimeReadiness } from '../operations/runtime-readiness';
import { ServicesController } from './services.controller';
import { SERVICES_CATALOGUE, SERVICES_CONTRACTS } from './services.tokens';

/**
 * MISSION A13 — service catalogue wiring.
 *
 * The typed request contract for the World Bank research service is loaded from the operator service
 * configuration file named by QEYNOX_SERVICE_CATALOG_PATH (for example infra/operator/a03-economic-research.json).
 * When the variable is unset, unreadable or invalid, the contract simply does not exist: the
 * catalogue still lists published offers with their real availability, and ordering those offers
 * fails closed with SERVICE_NOT_CONFIGURED instead of improvising a request shape.
 */

export const QEYNOX_SERVICE_CATALOG_PATH = 'QEYNOX_SERVICE_CATALOG_PATH';

function buildContracts(store: QeyNoxStore): ServiceContractRegistry | null {
  const catalogPath = (process.env[QEYNOX_SERVICE_CATALOG_PATH] ?? '').trim();
  if (!catalogPath) {
    console.log('[services] QEYNOX_SERVICE_CATALOG_PATH is not set; offers are listed but no request contract is registered');
    return null;
  }
  try {
    const raw = JSON.parse(readFileSync(catalogPath, 'utf8')) as { service?: unknown };
    const parsed = parseWorldBankServiceConfig(raw.service);
    const planning = new PlanningService(store);
    const contract = new WorldBankResearchContract(store, planning, parsed, apiRuntimeReadiness);
    console.log('[services] World Bank research contract registered for offer ' + parsed.offerId);
    return new ServiceContractRegistry([contract]);
  } catch (error: unknown) {
    // Fail closed: a malformed service definition never becomes a callable contract.
    console.error('[services] service catalog not configured:', error instanceof Error ? error.message : 'unknown error');
    return null;
  }
}

const deploymentProbe: DeploymentProbe = contractKey => {
  if (contractKey === WB_KEY) {
    return {
      worldBankEnabled: process.env.QEYNOX_WORLD_BANK_ENABLED === 'true',
      egressAttested: process.env.QEYNOX_NETWORK_POLICY_ATTESTED === 'true',
    };
  }
  return null;
};

@Module({
  controllers: [ServicesController],
  providers: [
    { provide: SERVICES_CONTRACTS, useFactory: (store: QeyNoxStore) => buildContracts(store), inject: [QEYNOX_STORE] },
    {
      provide: SERVICES_CATALOGUE,
      useFactory: (store: QeyNoxStore, contracts: ServiceContractRegistry | null) =>
        new ServiceCatalogueService(store, apiRuntimeReadiness, contracts, deploymentProbe),
      inject: [QEYNOX_STORE, SERVICES_CONTRACTS],
    },
  ],
})
export class ServicesModule {}

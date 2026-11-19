import { Module } from '@nestjs/common';
import { QeyNoxStore } from '@qeynox/persistence';
import { CapabilityCatalogueService } from '@qeynox/application';
import { QEYNOX_STORE } from '../database/database.module';
import { apiRuntimeReadiness } from '../operations/runtime-readiness';
import { CapabilitiesController } from './capabilities.controller';
import { CAPABILITY_CATALOGUE } from './capabilities.tokens';

@Module({
  controllers: [CapabilitiesController],
  providers: [{
    provide: CAPABILITY_CATALOGUE,
    // The catalogue reports the deployment's own runtime prerequisites, so a capability is only
    // presented as available when the engine/orchestrator are OPERATIONAL here, not merely configured.
    useFactory: (store: QeyNoxStore) => new CapabilityCatalogueService(store, apiRuntimeReadiness),
    inject: [QEYNOX_STORE],
  }],
})
export class CapabilitiesModule {}

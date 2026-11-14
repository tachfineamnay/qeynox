import { Module } from '@nestjs/common';
import { QeyNoxStore } from '@qeynox/persistence';
import { CapabilityCatalogueService } from '@qeynox/application';
import { QEYNOX_STORE } from '../database/database.module';
import { CapabilitiesController } from './capabilities.controller';
import { CAPABILITY_CATALOGUE } from './capabilities.tokens';

@Module({
  controllers: [CapabilitiesController],
  providers: [{ provide: CAPABILITY_CATALOGUE, useFactory: (store: QeyNoxStore) => new CapabilityCatalogueService(store), inject: [QEYNOX_STORE] }],
})
export class CapabilitiesModule {}

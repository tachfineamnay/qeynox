import { Module } from '@nestjs/common';
import { QeyNoxStore } from '@qeynox/persistence';
import { ConfigurationService } from '@qeynox/application';
import { QEYNOX_STORE } from '../database/database.module';
import { ConfigurationController } from './configuration.controller';
import { CONFIGURATION_SERVICE } from './configuration.tokens';
@Module({
  controllers: [ConfigurationController],
  providers: [{ provide: CONFIGURATION_SERVICE, useFactory: (store: QeyNoxStore) => new ConfigurationService(store), inject: [QEYNOX_STORE] }],
})
export class ConfigurationModule {}

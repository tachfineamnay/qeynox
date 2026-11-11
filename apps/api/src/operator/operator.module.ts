import { Module } from '@nestjs/common';
import { QeyNoxStore } from '@qeynox/persistence';
import { RecoveryService } from '@qeynox/application';
import { createHatchetInspector } from '@qeynox/orchestration';
import { QEYNOX_STORE } from '../database/database.module';
import { OperatorController } from './operator.controller';
import { RECOVERY_SERVICE } from './operator.tokens';
@Module({
  controllers: [OperatorController],
  providers: [
    {
      provide: RECOVERY_SERVICE,
      // Run observation uses the installed Hatchet SDK only when a client token is configured;
      // otherwise recovery stays fail-closed (UNSUPPORTED) rather than fabricating run state.
      useFactory: (store: QeyNoxStore) => new RecoveryService(store, createHatchetInspector()),
      inject: [QEYNOX_STORE],
    },
  ],
})
export class OperatorModule {}

import { Module } from '@nestjs/common';
import { QeyNoxStore } from '@qeynox/persistence';
import { ConnectionHubService } from '@qeynox/application';
import { QEYNOX_STORE } from '../database/database.module';
import { ConnectionsController } from './connections.controller';
import { CONNECTIONS_HUB } from './connections.tokens';

/**
 * MISSION A14 — connector hub wiring. The hub uses the code-reviewed provider declarations and the
 * deployment's credential key; unconfigured providers list and fail closed, never improvise.
 */
@Module({
  controllers: [ConnectionsController],
  providers: [
    { provide: CONNECTIONS_HUB, useFactory: (store: QeyNoxStore) => new ConnectionHubService(store), inject: [QEYNOX_STORE] },
  ],
})
export class ConnectionsModule {}

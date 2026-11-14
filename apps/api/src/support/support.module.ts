import { Module } from '@nestjs/common';
import { SupportService } from '@qeynox/application';
import { SupportLinkStore, type DatabaseConnection } from '@qeynox/persistence';
import { DB_CONNECTION } from '../database/database.module';
import { ChatwootClient } from './chatwoot.client';
import { SupportController } from './support.controller';
import { CHATWOOT_PORT, SUPPORT_LINK_STORE, SUPPORT_SERVICE } from './support.tokens';

@Module({
  controllers: [SupportController],
  providers: [
    { provide: CHATWOOT_PORT, useFactory: () => new ChatwootClient() },
    {
      provide: SUPPORT_LINK_STORE,
      useFactory: (connection: DatabaseConnection) => new SupportLinkStore(connection.db),
      inject: [DB_CONNECTION],
    },
    {
      provide: SUPPORT_SERVICE,
      useFactory: (port: ChatwootClient, links: SupportLinkStore) => new SupportService(port, links),
      inject: [CHATWOOT_PORT, SUPPORT_LINK_STORE],
    },
  ],
})
export class SupportModule {}

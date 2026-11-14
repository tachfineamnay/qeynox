import { Module } from '@nestjs/common';
import { WorkspaceAccessService } from '@qeynox/application';
import { WorkspaceStore, type DatabaseConnection } from '@qeynox/persistence';
import { DB_CONNECTION } from '../database/database.module';
import { WorkspacesController } from './workspaces.controller';
import { WORKSPACE_ACCESS_SERVICE, WORKSPACE_STORE } from './workspaces.tokens';

@Module({
  controllers: [WorkspacesController],
  providers: [
    {
      provide: WORKSPACE_STORE,
      useFactory: (connection: DatabaseConnection) => new WorkspaceStore(connection.db),
      inject: [DB_CONNECTION],
    },
    {
      provide: WORKSPACE_ACCESS_SERVICE,
      useFactory: (store: WorkspaceStore) => new WorkspaceAccessService(store),
      inject: [WORKSPACE_STORE],
    },
  ],
})
export class WorkspacesModule {}

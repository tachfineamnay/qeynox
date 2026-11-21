import { Module } from '@nestjs/common';
import { WorkspaceAccessService, createEmailTransportFromEnv } from '@qeynox/application';
import { NotificationStore, WorkspaceStore, type DatabaseConnection } from '@qeynox/persistence';
import { DB_CONNECTION } from '../database/database.module';
import { WorkspacesController } from './workspaces.controller';
import { WorkspaceTeamController } from './team.controller';
import { WorkspaceTeamService } from '@qeynox/application';
import { WORKSPACE_ACCESS_SERVICE, WORKSPACE_STORE } from './workspaces.tokens';
import { WORKSPACE_TEAM_SERVICE } from './team.tokens';

@Module({
  controllers: [WorkspacesController, WorkspaceTeamController],
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
    {
      // Invitation e-mails go through the real transport when one is configured; otherwise the
      // invitation is delivered manually (the token is shown once to the inviting admin).
      provide: WORKSPACE_TEAM_SERVICE,
      useFactory: (store: WorkspaceStore, connection: DatabaseConnection) => new WorkspaceTeamService(store, {
        email: createEmailTransportFromEnv(),
        deliveryLedger: new NotificationStore(connection.db),
        publicBaseUrl: process.env.QEYNOX_PUBLIC_URL ?? null,
      }),
      inject: [WORKSPACE_STORE, DB_CONNECTION],
    },
  ],
})
export class WorkspacesModule {}

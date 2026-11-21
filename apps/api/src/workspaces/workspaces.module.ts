import { Module } from '@nestjs/common';
import { BetaJourneyService, WorkspaceAccessService, WorkspaceBetaAccessService, commercePolicyFromEnvironment, createEmailTransportFromEnv } from '@qeynox/application';
import { apiRuntimeReadiness } from '../operations/runtime-readiness';
import { BetaAccessStore, NotificationStore, WorkspaceStore, type DatabaseConnection } from '@qeynox/persistence';
import { DB_CONNECTION } from '../database/database.module';
import { WorkspacesController } from './workspaces.controller';
import { WorkspaceTeamController } from './team.controller';
import { WorkspaceTeamService } from '@qeynox/application';
import { WORKSPACE_ACCESS_SERVICE, WORKSPACE_BETA_ACCESS_SERVICE, WORKSPACE_BETA_JOURNEY_SERVICE, WORKSPACE_STORE } from './workspaces.tokens';
import { WorkspaceBetaAccessController } from './beta-access.controller';
import { WORKSPACE_TEAM_SERVICE } from './team.tokens';

@Module({
  controllers: [WorkspacesController, WorkspaceTeamController, WorkspaceBetaAccessController],
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
    {
      // A21.02: status + activation of the acting workspace's beta grant (session-bound workspace).
      provide: WORKSPACE_BETA_ACCESS_SERVICE,
      useFactory: (connection: DatabaseConnection) => new WorkspaceBetaAccessService(new BetaAccessStore(connection.db)),
      inject: [DB_CONNECTION],
    },
    {
      // A21.04: the customer free-beta journey — commerce mode (read once at boot, like every commerce
      // service), the workspace grant (A21.02) and live runtime readiness, composed server-side.
      provide: WORKSPACE_BETA_JOURNEY_SERVICE,
      useFactory: (beta: WorkspaceBetaAccessService) => new BetaJourneyService(beta, commercePolicyFromEnvironment(), apiRuntimeReadiness),
      inject: [WORKSPACE_BETA_ACCESS_SERVICE],
    },
  ],
})
export class WorkspacesModule {}

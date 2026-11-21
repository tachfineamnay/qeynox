import { HealthController } from './health.controller';
import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './auth/auth.module';
import { OperationsModule } from './operations/operations.module';
import { ClaimsModule } from './claims/claims.module';
import { ResultsModule } from './results/results.module';
import { CommerceModule } from './commerce/commerce.module';
import { ActivityModule } from './activity/activity.module';
import { OperatorModule } from './operator/operator.module';
import { ConfigurationModule } from './configuration/configuration.module';
import { SoulModule } from './soul/soul.module';
import { PilotModule } from './pilot/pilot.module';
import { PlatformModule } from './platform/platform.module';
import { WorkspacesModule } from './workspaces/workspaces.module';
import { SupportModule } from './support/support.module';
import { CapabilitiesModule } from './capabilities/capabilities.module';
import { ServicesModule } from './services/services.module';
import { ConnectionsModule } from './connections/connections.module';
import { AccountModule } from './account/account.module';
import { DocumentsModule } from './documents/documents.module';
import { NotificationsModule } from './notifications/notifications.module';
@Module({controllers:[HealthController],imports:[DatabaseModule,AuthModule,OperationsModule,ClaimsModule,ResultsModule,CommerceModule,ActivityModule,OperatorModule,ConfigurationModule,SoulModule,PilotModule,PlatformModule,WorkspacesModule,SupportModule,CapabilitiesModule,ServicesModule,ConnectionsModule,DocumentsModule, AccountModule, NotificationsModule]})
export class AppModule {}

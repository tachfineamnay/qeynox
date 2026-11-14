import { randomBytes } from 'node:crypto';
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { PlatformAdminService, PlatformOrganizationsService, PlatformUsersService, type EmailTransport } from '@qeynox/application';
import { PlatformAdminStore, PlatformOperationsStore, PlatformUserStore, SupportLinkStore, WorkspaceStore, type DatabaseConnection } from '@qeynox/persistence';
import { AuthModule } from '../auth/auth.module';
import { AuthService } from '../auth/auth.service';
import { hashSessionToken } from '../auth/password';
import { DB_CONNECTION } from '../database/database.module';
import { createEmailTransport } from './email-transport.provider';
import { PlatformAccessGuard } from './platform-access.guard';
import { PlatformAdminController } from './platform-admin.controller';
import { PlatformAuthController } from './platform-auth.controller';
import { PlatformOrganizationsController } from './platform-organizations.controller';
import { PlatformUsersController } from './platform-users.controller';
import { ChatwootClient } from '../support/chatwoot.client';
import { PlatformSupportController } from '../support/platform-support.controller';
import { CoolifyReadOnlyClient } from './coolify-readonly.client';
import { EnvironmentDeploymentInfo } from './deployment-info.provider';
import { PlatformOperationsController } from './platform-operations.controller';
import { CHATWOOT_PORT, PLATFORM_SUPPORT_SERVICE, SUPPORT_LINK_STORE } from '../support/support.tokens';
import {
  EMAIL_TRANSPORT,
  PLATFORM_ADMIN_SERVICE,
  PLATFORM_ORGANIZATIONS_SERVICE,
  PLATFORM_ORGANIZATION_STORE,
  PLATFORM_STORE,
  PLATFORM_USERS_SERVICE,
  PLATFORM_USER_STORE,
  PLATFORM_OPERATIONS_STORE,
  PLATFORM_OPERATIONS_SERVICE,
  RESOURCE_INVENTORY_PORT,
  DEPLOYMENT_INFO,
} from './platform.tokens';

@Module({
  imports: [AuthModule],
  controllers: [PlatformAuthController, PlatformAdminController, PlatformUsersController, PlatformOrganizationsController, PlatformSupportController, PlatformOperationsController],
  providers: [
    {
      provide: PLATFORM_STORE,
      useFactory: (connection: DatabaseConnection) => new PlatformAdminStore(connection.db),
      inject: [DB_CONNECTION],
    },
    {
      provide: PLATFORM_ADMIN_SERVICE,
      // Reuses the existing identity AuthService for credential verification (scrypt, lockout,
      // timing-safe comparison) and the existing session token hash instead of duplicating them.
      useFactory: (store: PlatformAdminStore, auth: AuthService) => new PlatformAdminService(
        store,
        { verifyCredentials: (email: string, password: string) => auth.verifyCredentials(email, password) },
        { hashToken: hashSessionToken, generateToken: () => randomBytes(48).toString('base64url') },
      ),
      inject: [PLATFORM_STORE, AuthService],
    },
    {
      provide: PLATFORM_USER_STORE,
      useFactory: (connection: DatabaseConnection) => new PlatformUserStore(connection.db),
      inject: [DB_CONNECTION],
    },
    {
      provide: EMAIL_TRANSPORT,
      // The only transport is not configured: account-lifecycle features stay blocked.
      useFactory: () => createEmailTransport(),
    },
    {
      provide: PLATFORM_USERS_SERVICE,
      useFactory: (store: PlatformUserStore, platform: PlatformAdminService, email: EmailTransport) => new PlatformUsersService(store, platform, email),
      inject: [PLATFORM_USER_STORE, PLATFORM_ADMIN_SERVICE, EMAIL_TRANSPORT],
    },
    {
      provide: PLATFORM_ORGANIZATION_STORE,
      useFactory: (connection: DatabaseConnection) => new WorkspaceStore(connection.db),
      inject: [DB_CONNECTION],
    },
    {
      provide: PLATFORM_ORGANIZATIONS_SERVICE,
      useFactory: (store: WorkspaceStore, platform: PlatformAdminService) => new PlatformOrganizationsService(store, platform),
      inject: [PLATFORM_ORGANIZATION_STORE, PLATFORM_ADMIN_SERVICE],
    },
    { provide: CHATWOOT_PORT, useFactory: () => new ChatwootClient() },
    {
      provide: SUPPORT_LINK_STORE,
      useFactory: (connection: DatabaseConnection) => new SupportLinkStore(connection.db),
      inject: [DB_CONNECTION],
    },
    {
      provide: PLATFORM_SUPPORT_SERVICE,
      useFactory: (port: ChatwootClient, links: SupportLinkStore, platform: PlatformAdminService) => new PlatformSupportService(port, links, platform),
      inject: [CHATWOOT_PORT, SUPPORT_LINK_STORE, PLATFORM_ADMIN_SERVICE],
    },
    {
      provide: PLATFORM_OPERATIONS_STORE,
      useFactory: (connection: DatabaseConnection) => new PlatformOperationsStore(connection.db),
      inject: [DB_CONNECTION],
    },
    { provide: RESOURCE_INVENTORY_PORT, useFactory: () => new CoolifyReadOnlyClient() },
    { provide: DEPLOYMENT_INFO, useFactory: () => new EnvironmentDeploymentInfo() },
    {
      provide: PLATFORM_OPERATIONS_SERVICE,
      useFactory: (store: PlatformOperationsStore, runtime: PlatformAdminStore, platform: PlatformAdminService, deployment: EnvironmentDeploymentInfo, resources: CoolifyReadOnlyClient) =>
        new PlatformOperationsService(store, runtime, platform, deployment, resources),
      inject: [PLATFORM_OPERATIONS_STORE, PLATFORM_STORE, PLATFORM_ADMIN_SERVICE, DEPLOYMENT_INFO, RESOURCE_INVENTORY_PORT],
    },
    { provide: APP_GUARD, useClass: PlatformAccessGuard },
  ],
})
export class PlatformModule {}
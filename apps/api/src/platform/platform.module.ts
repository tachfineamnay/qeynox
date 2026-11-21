import { randomBytes } from 'node:crypto';
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { PlatformAdminService, PlatformBetaAccessService, PlatformCatalogueService, PlatformConfigurationService, PlatformOperationsService, PlatformOrganizationsService, PlatformRegistrationInvitationService, PlatformSupportService, PlatformUsersService, type EmailTransport } from '@qeynox/application';
import { BetaAccessStore, NotificationStore, PlatformAdminStore, PlatformOperationsStore, PlatformUserStore, RegistrationStore, SupportLinkStore, WorkspaceStore, type DatabaseConnection, type QeyNoxStore } from '@qeynox/persistence';
import { AuthModule } from '../auth/auth.module';
import { AuthService } from '../auth/auth.service';
import { hashSessionToken } from '../auth/password';
import { DB_CONNECTION, QEYNOX_STORE } from '../database/database.module';
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
import { PlatformCatalogueController } from './platform-catalogue.controller';
import { PlatformConfigurationController } from './platform-configuration.controller';
import { PlatformBetaAccessController } from './platform-beta-access.controller';
import { PlatformRegistrationInvitationsController } from './platform-registration-invitations.controller';
import { apiRuntimeReadiness } from '../operations/runtime-readiness';
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
  PLATFORM_CATALOGUE_SERVICE,
  PLATFORM_CONFIGURATION_SERVICE,
  PLATFORM_BETA_ACCESS_SERVICE,
  PLATFORM_REGISTRATION_INVITATION_SERVICE,
} from './platform.tokens';

@Module({
  imports: [AuthModule],
  controllers: [PlatformAuthController, PlatformAdminController, PlatformUsersController, PlatformOrganizationsController, PlatformSupportController, PlatformOperationsController, PlatformCatalogueController, PlatformConfigurationController, PlatformBetaAccessController, PlatformRegistrationInvitationsController],
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
      // Fails closed unless QEYNOX_EMAIL_PROVIDER=resend plus its secrets are set (A19).
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
      useFactory: (store: WorkspaceStore, platform: PlatformAdminService, connection: DatabaseConnection) => new PlatformOrganizationsService(store, platform, {
        email: createEmailTransport(),
        deliveryLedger: new NotificationStore(connection.db),
        publicBaseUrl: process.env.QEYNOX_PUBLIC_URL ?? null,
      }),
      inject: [PLATFORM_ORGANIZATION_STORE, PLATFORM_ADMIN_SERVICE, DB_CONNECTION],
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
    {
      provide: PLATFORM_CATALOGUE_SERVICE,
      // Read-only: the operator allowlist and endpoint are reported, never invoked from here.
      useFactory: (store: QeyNoxStore, platform: PlatformAdminService) => new PlatformCatalogueService(
        store,
        platform,
        apiRuntimeReadiness,
        {
          allowlistConfigured: Boolean((process.env.QEYNOX_OPERATOR_USER_IDS ?? '').trim()),
          configurationEndpoint: '/v1/operator/configuration/apply',
          platformConfigurationEndpoint: '/v1/platform/configuration/apply',
        },
      ),
      inject: [QEYNOX_STORE, PLATFORM_ADMIN_SERVICE],
    },
    {
      provide: PLATFORM_CONFIGURATION_SERVICE,
      // The platform route reaches the same ConfigurationService engine; it synthesizes an
      // in-memory workspace Principal (never a session token) with the actor's real membership role.
      useFactory: (store: QeyNoxStore, platform: PlatformAdminService, workspaces: WorkspaceStore) => new PlatformConfigurationService(store, platform, workspaces),
      inject: [QEYNOX_STORE, PLATFORM_ADMIN_SERVICE, PLATFORM_ORGANIZATION_STORE],
    },
    {
      // A21.02: invite-only beta grants. Authorization reuses the platform operator model
      // (ADMINISTRATION to grant/revoke) and audits into platform_admin_audit.
      provide: PLATFORM_BETA_ACCESS_SERVICE,
      useFactory: (connection: DatabaseConnection, platform: PlatformAdminService) => new PlatformBetaAccessService(new BetaAccessStore(connection.db), platform),
      inject: [DB_CONNECTION, PLATFORM_ADMIN_SERVICE],
    },
    {
      // A21.05: invite-only registration. Same operator model as beta grants (ADMINISTRATION to
      // issue/revoke, audited into platform_admin_audit); redemption happens in AuthService.register.
      provide: PLATFORM_REGISTRATION_INVITATION_SERVICE,
      useFactory: (connection: DatabaseConnection, platform: PlatformAdminService) => new PlatformRegistrationInvitationService(new RegistrationStore(connection.db), platform),
      inject: [DB_CONNECTION, PLATFORM_ADMIN_SERVICE],
    },
    { provide: APP_GUARD, useClass: PlatformAccessGuard },
  ],
})
export class PlatformModule {}
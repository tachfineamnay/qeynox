import { randomBytes } from 'node:crypto';
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { PlatformAdminService, PlatformUsersService, type EmailTransport } from '@qeynox/application';
import { PlatformAdminStore, PlatformUserStore, type DatabaseConnection } from '@qeynox/persistence';
import { AuthModule } from '../auth/auth.module';
import { AuthService } from '../auth/auth.service';
import { hashSessionToken } from '../auth/password';
import { DB_CONNECTION } from '../database/database.module';
import { createEmailTransport } from './email-transport.provider';
import { PlatformAccessGuard } from './platform-access.guard';
import { PlatformAdminController } from './platform-admin.controller';
import { PlatformAuthController } from './platform-auth.controller';
import { PlatformUsersController } from './platform-users.controller';
import {
  EMAIL_TRANSPORT,
  PLATFORM_ADMIN_SERVICE,
  PLATFORM_STORE,
  PLATFORM_USERS_SERVICE,
  PLATFORM_USER_STORE,
} from './platform.tokens';

@Module({
  imports: [AuthModule],
  controllers: [PlatformAuthController, PlatformAdminController, PlatformUsersController],
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
    { provide: APP_GUARD, useClass: PlatformAccessGuard },
  ],
})
export class PlatformModule {}

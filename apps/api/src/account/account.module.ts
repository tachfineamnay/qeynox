import { Module } from '@nestjs/common';
import { AccountSettingsService } from '@qeynox/application';
import { AccountStore, type DatabaseConnection } from '@qeynox/persistence';
import { DB_CONNECTION } from '../database/database.module';
import { hashPassword, verifyPassword } from '../auth/password';
import { AccountController } from './account.controller';
import { ACCOUNT_SETTINGS } from './account.tokens';

/**
 * MISSION A18 — customer account settings module.
 *
 * The hasher binding delegates to the same scrypt implementation used at sign-in and registration
 * (apps/api/src/auth/password.ts) — no second credential scheme is introduced.
 */
@Module({
  controllers: [AccountController],
  providers: [
    {
      provide: ACCOUNT_SETTINGS,
      useFactory: (connection: DatabaseConnection) => new AccountSettingsService(new AccountStore(connection.db), {
        hasher: {
          hash: (password: string, salt?: string) => hashPassword(password, salt),
          verify: (password: string, salt: string, expected: string) => verifyPassword(password, salt, expected),
        },
      }),
      inject: [DB_CONNECTION],
    },
  ],
  exports: [ACCOUNT_SETTINGS],
})
export class AccountModule {}

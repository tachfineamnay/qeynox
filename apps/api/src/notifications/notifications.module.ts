import { Module } from '@nestjs/common';
import { NotificationService, createEmailTransportFromEnv } from '@qeynox/application';
import { NotificationStore, type DatabaseConnection } from '@qeynox/persistence';
import { DB_CONNECTION } from '../database/database.module';
import { NotificationsController } from './notifications.controller';
import { NOTIFICATIONS } from './notifications.tokens';

/**
 * MISSION A19 — customer notifications: in-app inbox (read/unread), per-category e-mail
 * preferences and the delivery ledger used by the worker's drain loop.
 *
 * The API serves reads and mark-as-read/preferences only. Delivery is a background concern:
 * the worker materializes events into notifications and drains due e-mail deliveries.
 */
@Module({
  controllers: [NotificationsController],
  providers: [
    {
      provide: NOTIFICATIONS,
      useFactory: (connection: DatabaseConnection) => new NotificationService(
        new NotificationStore(connection.db),
        createEmailTransportFromEnv(),
        { publicBaseUrl: process.env.QEYNOX_PUBLIC_URL ?? null },
      ),
      inject: [DB_CONNECTION],
    },
  ],
  exports: [NOTIFICATIONS],
})
export class NotificationsModule {}

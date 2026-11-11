import { Global, Injectable, Module, OnModuleDestroy } from '@nestjs/common';
import { connectDatabase, QeyNoxStore, type DatabaseConnection } from '@qeynox/persistence';

export const DB_CONNECTION = Symbol('QEYNOX_DATABASE_CONNECTION');
export const QEYNOX_STORE = Symbol('QEYNOX_STORE');

@Injectable()
class ConnectionLifecycle implements OnModuleDestroy {
  constructor(public readonly connection: DatabaseConnection) {}
  async onModuleDestroy(): Promise<void> { await this.connection.close(); }
}

@Global()
@Module({
  providers: [
    {provide: DB_CONNECTION, useFactory: () => connectDatabase(process.env.DATABASE_URL)},
    {provide: QEYNOX_STORE, useFactory: (conn: DatabaseConnection) => new QeyNoxStore(conn.db), inject:[DB_CONNECTION]},
    {provide:ConnectionLifecycle, useFactory:(conn:DatabaseConnection)=>new ConnectionLifecycle(conn),inject:[DB_CONNECTION]},
  ],
  exports:[DB_CONNECTION,QEYNOX_STORE],
})
export class DatabaseModule {}

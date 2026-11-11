import { Pool } from 'pg';
import { drizzle,type NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema';
import { DomainError } from '@qeynox/domain';
export type QeyNoxDatabase=NodePgDatabase<typeof schema>;
export interface DatabaseConnection {db:QeyNoxDatabase;pool:Pool;close():Promise<void>}
export function connectDatabase(connectionString:string|undefined):DatabaseConnection{
 if(!connectionString)throw new DomainError('NOT_CONFIGURED','DATABASE_URL required');
 const pool=new Pool({connectionString,max:10,idleTimeoutMillis:30000,connectionTimeoutMillis:10000});
 // An unhandled idle-client error would terminate the API/worker process; log and let the pool recover.
 pool.on('error',error=>{console.error('QeyNox database pool error:',error instanceof Error?error.message:'unknown database error');});
 const db=drizzle({client:pool,schema});
 return {db,pool,close:()=>pool.end()};
}

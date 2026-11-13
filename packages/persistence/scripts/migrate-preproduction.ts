import { Pool } from 'pg';
import { runMigrations } from '../src/migrate';

async function main() {
 if(process.env.QEYNOX_DEPLOYMENT_ENV !== 'preproduction' || process.env.QEYNOX_ALLOW_PREPRODUCTION_MIGRATIONS !== 'true') throw new Error('Explicit preproduction migration authorization required');
 const raw=process.env.DATABASE_URL;
 if(!raw) throw new Error('DATABASE_URL required');
 const url=new URL(raw);
 const database=decodeURIComponent(url.pathname.slice(1));
 if(database !== 'qeynox' || process.env.QEYNOX_MIGRATION_DATABASE !== database) throw new Error('Exact QeyNox database confirmation required');
 const pool=new Pool({connectionString:raw,max:1});
 try {
  const result=await pool.query<{count:string}>("SELECT count(*)::text AS count FROM information_schema.tables WHERE table_schema='public'");
  if(Number(result.rows[0]?.count)!==0) throw new Error('Initial preproduction migration requires an empty database; populated upgrades need a separate backup-controlled procedure');
 } finally {await pool.end();}
 const report=await runMigrations(raw);
 console.log(JSON.stringify({target:'preproduction',total:report.total,applied:report.applied.length}));
}
main().catch(error=>{console.error(error instanceof Error?error.message:'Migration failed');process.exitCode=1;});

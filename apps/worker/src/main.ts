import { startQeyNoxWorker } from '@qeynox/orchestration';
import { connectDatabase } from '@qeynox/persistence';
import { createWorkerDependencies,startProjectionPolling } from './runtime';

async function main() {
  const projectionConnection=connectDatabase(process.env.DATABASE_URL);
  const stopProjection=startProjectionPolling(projectionConnection.db);
  let closing=false;
  let dependencies:Awaited<ReturnType<typeof createWorkerDependencies>>|undefined;
  const shutdown=async()=>{if(closing)return;closing=true;await stopProjection();await dependencies?.close();await projectionConnection.close();process.exit(0);};
  process.once('SIGINT',()=>{void shutdown();});process.once('SIGTERM',()=>{void shutdown();});
  while(!closing){
    try {dependencies=await createWorkerDependencies();await startQeyNoxWorker(dependencies);}
    catch(error:unknown){console.error('Hatchet worker unavailable; projection continues:',error instanceof Error?error.message:'unknown error');}
    finally {await dependencies?.close();dependencies=undefined;}
    if(!closing)await new Promise(resolve=>setTimeout(resolve,5000));
  }
}
main().catch((error: unknown) => {
  console.error('Worker stopped:', error instanceof Error ? error.message : 'unknown error');
  process.exitCode = 1;
});

import { startQeyNoxWorker } from '@qeynox/orchestration';
import { connectDatabase } from '@qeynox/persistence';
import { createWorkerDependencies,startProjectionPolling } from './runtime';

async function main() {
  const projectionConnection=connectDatabase(process.env.DATABASE_URL);
  const stopProjection=startProjectionPolling(projectionConnection.db);
  let closing=false;
  const abort=new AbortController();
  let dependencies:Awaited<ReturnType<typeof createWorkerDependencies>>|undefined;
  let workerFinished:Promise<void>|undefined;
  const shutdown=async()=>{if(closing)return;closing=true;await dependencies?.stopDispatcher();abort.abort();await workerFinished;await stopProjection();await projectionConnection.close();};
  process.once('SIGINT',()=>{void shutdown();});process.once('SIGTERM',()=>{void shutdown();});
  while(!closing){
    try {dependencies=await createWorkerDependencies();workerFinished=startQeyNoxWorker(dependencies,abort.signal);await workerFinished;}
    catch(error:unknown){console.error('Hatchet worker unavailable; projection continues:',error instanceof Error?error.message:'unknown error');}
    finally {await dependencies?.close();dependencies=undefined;}
    if(!closing)await new Promise(resolve=>setTimeout(resolve,5000));
  }
}
main().catch((error: unknown) => {
  console.error('Worker stopped:', error instanceof Error ? error.message : 'unknown error');
  process.exitCode = 1;
});

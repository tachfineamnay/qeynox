import { startWorkerHeartbeat } from './health';
import { startQeyNoxWorker } from '@qeynox/orchestration';
import { createWorkerDependencies } from './runtime';

async function main() {
  const deps = await createWorkerDependencies();
  let stopHeartbeat: (() => Promise<void>) | undefined;
  // MISSION A21.07: keep live evidence for Hermes and Hatchet fresh in the background.
  try {
    stopHeartbeat = await startWorkerHeartbeat();
    deps.runtimeMonitor.start();
    await startQeyNoxWorker(deps);
  } finally {
    try { await deps.close(); } finally { await stopHeartbeat?.(); }
  }
}
main().catch((error: unknown) => {
  console.error('Worker stopped:', error instanceof Error ? error.message : 'unknown error');
  process.exitCode = 1;
});

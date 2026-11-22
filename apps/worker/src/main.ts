import { startQeyNoxWorker } from '@qeynox/orchestration';
import { createWorkerDependencies } from './runtime';

async function main() {
  const deps = await createWorkerDependencies();
  // MISSION A21.07: keep live evidence for Hermes and Hatchet fresh in the background.
  try {
    deps.runtimeMonitor.start();
    await startQeyNoxWorker(deps);
  } finally { await deps.close(); }
}
main().catch((error: unknown) => {
  console.error('Worker stopped:', error instanceof Error ? error.message : 'unknown error');
  process.exitCode = 1;
});

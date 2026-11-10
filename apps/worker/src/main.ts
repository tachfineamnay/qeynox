import { startQeyNoxWorker } from '@qeynox/orchestration';
import { createWorkerDependencies } from './runtime';

async function main() {
  await startQeyNoxWorker(await createWorkerDependencies());
}
main().catch((error: unknown) => {
  console.error('Worker stopped:', error instanceof Error ? error.message : 'unknown error');
  process.exitCode = 1;
});

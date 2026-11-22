import { writeFile, rename, unlink } from 'node:fs/promises';

/** Process/event-loop liveness only, not a claim that Hatchet/Hermes or a mission is ready. */
export async function startWorkerHeartbeat(): Promise<() => Promise<void>> {
  const file = '/tmp/qeynox-worker-health.json';
  let stopped = false;
  let inFlight: Promise<void> | undefined;
  const tick = async () => {
    if (stopped) return;
    await writeFile(file + '.tmp', JSON.stringify({ sha: process.env.QEYNOX_RELEASE_SHA ?? null, version: process.env.QEYNOX_RELEASE_VERSION ?? null }));
    await rename(file + '.tmp', file);
  };
  await tick();
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = tick().catch(() => { /* A stale heartbeat makes the container unhealthy. */ }).finally(() => { inFlight = undefined; });
  }, 10_000);
  timer.unref();
  return async () => {
    stopped = true; clearInterval(timer); await inFlight;
    await unlink(file).catch(() => undefined);
  };
}

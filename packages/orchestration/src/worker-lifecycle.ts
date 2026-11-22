/** Process lifecycle only: durable execution remains exclusively Hatchet's responsibility. */
export interface WorkerLifecyclePort {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface WorkerSignalsPort {
  on(event: 'SIGINT' | 'SIGTERM', listener: () => void): void;
  off(event: 'SIGINT' | 'SIGTERM', listener: () => void): void;
}

export async function runManagedWorker(
  worker: WorkerLifecyclePort,
  background: { start(): Promise<void>; stop(): Promise<void> },
  signals: WorkerSignalsPort = process,
): Promise<void> {
  let stopping = false;
  let notify: () => void = () => {};
  const signal = new Promise<void>(resolve => { notify = resolve; });
  const requestStop = () => { stopping = true; notify(); };
  signals.on('SIGTERM', requestStop);
  signals.on('SIGINT', requestStop);
  let running: Promise<void> | undefined;
  try {
    await background.start();
    if (!stopping) {
      running = worker.start();
      await Promise.race([running, signal]);
    }
  } finally {
    // Keep DB resources alive until both background drains and the SDK have stopped.
    // Nested finally ensures an error in one teardown cannot skip the remaining teardown.
    try { await background.stop(); }
    finally {
      try { await worker.stop(); }
      finally {
        try { await running; }
        finally {
          signals.off('SIGTERM', requestStop);
          signals.off('SIGINT', requestStop);
        }
      }
    }
  }
}

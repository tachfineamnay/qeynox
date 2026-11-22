/** Infrastructure polling only, not a business workflow scheduler. */
export class SerialPoller {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<void> | undefined;
  private stopped = false;

  constructor(
    private readonly task: () => Promise<void>,
    private readonly intervalMs: number,
    private readonly onError: (error: unknown) => void,
  ) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1 || intervalMs > 2_147_483_647) {
      throw new RangeError('Invalid polling interval');
    }
  }

  /** Repeated starts share the same first drain and never create another polling loop. */
  start(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.inFlight ??= this.tick();
    return this.inFlight;
  }

  /** Prevent further drains and wait for the active one before its resources can be closed. */
  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.inFlight;
  }

  private async tick(): Promise<void> {
    try {
      await this.task();
    } catch (error: unknown) {
      // A reporting failure must not become an unhandled rejection from a timer callback.
      try { this.onError(error); }
      catch (reportError: unknown) { console.error('Polling error reporter failed:', reportError instanceof Error ? reportError.message : 'unknown'); }
    } finally {
      if (!this.stopped) {
        this.timer = setTimeout(() => { this.inFlight = this.tick(); }, this.intervalMs);
      }
    }
  }
}

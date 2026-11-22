import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { runManagedWorker } from '../../../packages/orchestration/src/worker-lifecycle';
import { SerialPoller } from '../src/serial-poller';

function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  test('managed worker drains before SDK stop and DB close on ' + signal, async () => {
    const signals = new EventEmitter();
    const started = deferred(), drain = deferred(), workerDone = deferred();
    const events: string[] = [];
    const poller = new SerialPoller(async () => { events.push('drain'); started.resolve(); await drain.promise; events.push('drained'); }, 5, error => { throw error; });
    const running = runManagedWorker({
      start: () => { events.push('worker-start'); return workerDone.promise; },
      stop: async () => { events.push('worker-stop'); workerDone.resolve(); },
    }, {
      start: async () => { void poller.start(); },
      stop: async () => { events.push('background-stop'); await poller.stop(); events.push('background-stopped'); },
    }, signals).finally(() => { events.push('db-close'); });
    await started.promise;
    await Promise.resolve();
    signals.emit(signal);
    signals.emit(signal);
    await Promise.resolve();
    assert.equal(events.includes('db-close'), false, 'resource close must wait for active drain');
    assert.equal(events.includes('worker-stop'), false);
    drain.resolve();
    await running;
    assert.deepEqual(events, ['drain', 'worker-start', 'background-stop', 'drained', 'background-stopped', 'worker-stop', 'db-close']);
    assert.equal(signals.listenerCount('SIGINT'), 0);
    assert.equal(signals.listenerCount('SIGTERM'), 0);
  });
}

test('startup failure still stops partially started background and worker', async () => {
  const signals = new EventEmitter(), events: string[] = [];
  await assert.rejects(runManagedWorker({
    start: async () => { throw new Error('must not start'); }, stop: async () => { events.push('worker-stop'); },
  }, {
    start: async () => { throw new Error('startup failure'); }, stop: async () => { events.push('background-stop'); },
  }, signals), /startup failure/);
  assert.deepEqual(events, ['background-stop', 'worker-stop']);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
});

test('worker failure cleans background and signal listeners', async () => {
  const signals = new EventEmitter(), events: string[] = [];
  await assert.rejects(runManagedWorker({
    start: async () => { throw new Error('SDK failure'); }, stop: async () => { events.push('worker-stop'); },
  }, { start: async () => {}, stop: async () => { events.push('background-stop'); } }, signals), /SDK failure/);
  assert.deepEqual(events, ['background-stop', 'worker-stop']);
  assert.equal(signals.listenerCount('SIGINT'), 0);
});

test('a cleanup failure cannot skip SDK stop or listener removal', async () => {
  const signals = new EventEmitter();
  let stopped = false;
  await assert.rejects(runManagedWorker({ start: async () => {}, stop: async () => { stopped = true; } }, {
    start: async () => {}, stop: async () => { throw new Error('background teardown failed'); },
  }, signals), /background teardown failed/);
  assert.equal(stopped, true);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
});

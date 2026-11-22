import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { diagnostics } from './contract.mjs';
import { mintStorageTransfer, openStorageTransfer, boundedTransferBody, maxTransferBytes } from '../../apps/web/src/lib/storage-transfer';

const image = { sha: 'a'.repeat(40), version: 'p16-local-safety' };
const common = { NODE_ENV: 'production', QEYNOX_DEPLOYMENT_ENV: 'preproduction', QEYNOX_RELEASE_SHA: image.sha, QEYNOX_RELEASE_VERSION: image.version, QEYNOX_COMMERCE_MODE: 'BETA_FREE', QEYNOX_REGISTRATION_MODE: 'INVITE_ONLY', QEYNOX_PUBLIC_URL: 'https://example.invalid' };
const web = { ...common, QEYNOX_API_URL: 'http://qeynox-api:4000', QEYNOX_API_PRIVATE_ORIGIN: 'http://qeynox-api:4000', QEYNOX_STORAGE_RELAY_KEY: Buffer.alloc(32, 7).toString('base64'), QEYNOX_ARTIFACT_ENDPOINT: 'http://qeynox-storage:9000', QEYNOX_ARTIFACT_BUCKET: 'qa-private' };

test('release identity, frozen beta policies and credential-safe diagnostics', () => {
  assert.deepEqual(diagnostics('web', web, image), []);
  for (const [key, value] of [['QEYNOX_COMMERCE_MODE', 'PAID'], ['QEYNOX_REGISTRATION_MODE', 'OPEN'], ['QEYNOX_ALLOW_DATABASE_UPGRADE', 'true'], ['QEYNOX_STRIPE_SECRET_KEY', 'qa-must-not-be-emitted']]) {
    const issues = diagnostics('web', { ...web, [key!]: value }, image);
    assert(issues.length > 0);
    assert.equal(JSON.stringify(issues).includes('qa-must-not-be-emitted'), false);
  }
  assert(diagnostics('web', web, { ...image, sha: 'b'.repeat(40) }).some(issue => issue.code === 'IMAGE_ENV_SKEW'));
  assert(diagnostics('web', { ...web, QEYNOX_API_URL: 'https://public-api.invalid' }, image).length > 0);
});

test('private S3 transfer tickets are encrypted, session/workspace/method bound, expiring and tamper resistant', () => {
  const raw = 'http://qeynox-storage:9000/qa-private/workspaces/qa-workspace/documents/object.txt?X-Amz-Signature=' + '1'.repeat(64);
  const url = mintStorageTransfer(raw, 'GET', 'qa-workspace', 'qa-session', web, 1_000_000);
  assert.equal(url.includes('qeynox-storage'), false);
  const ticket = new URL(url).searchParams.get('ticket')!;
  assert.equal(openStorageTransfer(ticket, 'GET', 'qa-workspace', 'qa-session', web, 1_000_001).href, raw);
  for (const [method, workspace, session, time] of [['PUT', 'qa-workspace', 'qa-session', 1_000_001], ['GET', 'other-workspace', 'qa-session', 1_000_001], ['GET', 'qa-workspace', 'other-session', 1_000_001], ['GET', 'qa-workspace', 'qa-session', 1_120_001]] as const) {
    assert.throws(() => openStorageTransfer(ticket, method, workspace, session, web, time));
  }
  assert.throws(() => openStorageTransfer((ticket[0] === 'A' ? 'B' : 'A') + ticket.slice(1), 'GET', 'qa-workspace', 'qa-session', web, 1_000_001));
  for (const target of [raw.replace('qeynox-storage:9000', '169.254.169.254'), raw.replace('qa-workspace', 'other-workspace'), raw.replace('/qa-workspace/documents/object.txt', '/qa-workspace/../../other-workspace/object.txt'), 'http://qeynox-storage:9000/minio/admin']) {
    assert.throws(() => mintStorageTransfer(target, 'GET', 'qa-workspace', 'qa-session', web, 1_000_000));
  }
});

test('storage relay bounds chunked data before buffering the entire transfer', async () => {
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(maxTransferBytes)); controller.enqueue(new Uint8Array(1)); controller.close(); } });
  await assert.rejects(boundedTransferBody(stream), /TRANSFER_TOO_LARGE/);
  assert.equal((await boundedTransferBody(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1, 2])); c.close(); } }))).byteLength, 2);
});

test('read-only inventory refuses missing credentials without a network fallback', () => {
  const result = spawnSync(process.execPath, ['infra/release/inspect-coolify.mjs'], { env: { PATH: process.env.PATH }, encoding: 'utf8' });
  assert.equal(result.status, 3);
  assert.match(result.stdout, /QEYNOX_COOLIFY_API_TOKEN/);
  assert.match(result.stdout, /BLOCKED/);
});

test('release topology does not recreate financial storage and no service manifest exposes S3/Hermes', async () => {
  const compose = await readFile('infra/compose.release.yml', 'utf8');
  assert.equal(/^\s+ports:/m.test(compose), false);
  assert.equal(/^volumes:/m.test(compose), false);
  assert.match(compose, /stop_grace_period: 300s/);
  assert.match(compose, /Path\(`\/admin`\) \|\| PathPrefix\(`\/admin\/`\)/);
  for (const name of ['storage', 'hermes', 'hatchet']) {
    const manifest = await readFile('infra/services/' + name + '.yml', 'utf8');
    assert.match(manifest, /traefik.enable=false/);
    assert.equal(/^\s+ports:/m.test(manifest), false);
    assert.equal(manifest.includes('traefik.enable=true'), false);
  }
});

test('worker shutdown drains background before SDK and removes signal handlers', async () => {
  const { EventEmitter } = await import('node:events');
  const { runManagedWorker } = await import('../../packages/orchestration/src/worker-lifecycle');
  const signals = new EventEmitter();
  const calls: string[] = [];
  let finish: () => void = () => { throw new Error('Worker not started'); };
  await runManagedWorker({
    start() { calls.push('worker-start'); return new Promise<void>(resolve => { finish = resolve; queueMicrotask(() => signals.emit('SIGTERM')); }); },
    async stop() { calls.push('worker-stop'); finish(); },
  }, { async start() { calls.push('background-start'); }, async stop() { calls.push('background-stop'); } }, signals);
  assert.deepEqual(calls, ['background-start', 'worker-start', 'background-stop', 'worker-stop']);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
  assert.equal(signals.listenerCount('SIGINT'), 0);
});

test('all backend required secrets and private endpoints fail closed', () => {
  const api = { ...common, DATABASE_URL: 'postgresql://qa:qa@qeynox-postgres:5432/qa', QEYNOX_REDIS_URL: 'redis://:qa@qeynox-redis/0', HATCHET_CLIENT_TOKEN: 'qa-token', HATCHET_CLIENT_API_URL: 'http://qeynox-hatchet:8888', HATCHET_CLIENT_HOST_PORT: 'qeynox-hatchet:7077', HATCHET_CLIENT_TLS_STRATEGY: 'none', HERMES_API_BASE_URL: 'http://qeynox-hermes:8642/v1/', HERMES_PRIVATE_ORIGIN: 'http://qeynox-hermes:8642', HERMES_API_KEY: 'qa-key', HERMES_MODEL: 'qa-model', QEYNOX_ARTIFACT_ENDPOINT: web.QEYNOX_ARTIFACT_ENDPOINT, QEYNOX_ARTIFACT_BUCKET: web.QEYNOX_ARTIFACT_BUCKET, QEYNOX_ARTIFACT_REGION: 'us-east-1', QEYNOX_ARTIFACT_ACCESS_KEY: 'qa-access', QEYNOX_ARTIFACT_SECRET_KEY: 'qa-secret', QEYNOX_SERVICE_CATALOG_PATH: 'infra/operator/a16-business-packs.json', QEYNOX_EMAIL_PROVIDER: 'resend', QEYNOX_RESEND_API_KEY: 'qa-resend', QEYNOX_EMAIL_FROM: 'qa@example.invalid', QEYNOX_OPERATOR_USER_IDS: 'qa-operator', QEYNOX_ARTIFACT_SERVER_SIDE_ENCRYPTION: 'AES256' };
  assert.deepEqual(diagnostics('api', api, image), []);
  assert.deepEqual(diagnostics('worker', api, image), []);
  for (const key of ['DATABASE_URL', 'QEYNOX_REDIS_URL', 'HATCHET_CLIENT_TOKEN', 'HERMES_API_KEY', 'QEYNOX_ARTIFACT_SECRET_KEY', 'QEYNOX_RESEND_API_KEY']) {
    assert(diagnostics('api', { ...api, [key]: '' }, image).some(issue => issue.key === key));
  }
  assert(diagnostics('api', { ...api, DATABASE_URL: 'postgresql://qa:qa@public.invalid:5432/qa' }, image).length > 0);
});

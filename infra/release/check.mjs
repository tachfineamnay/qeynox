import { readFile } from 'node:fs/promises';
import net from 'node:net';
import { createRequire } from 'node:module';
import { diagnostics } from './contract.mjs';

const role = process.argv[2];
let image;
try { image = JSON.parse(await readFile(new URL('../../.qeynox-release.json', import.meta.url), 'utf8')); }
catch { console.error(JSON.stringify({ code: 'IMAGE_RELEASE_METADATA_MISSING' })); process.exit(1); }
const issues = diagnostics(role, process.env, image);
if (issues.length) { console.error(JSON.stringify({ code: 'RELEASE_CONFIGURATION_BLOCKED', role, issues })); process.exit(1); }
if (['api', 'worker'].includes(role)) {
  try {
    for (const path of process.env.QEYNOX_SERVICE_CATALOG_PATH.split(',').map(value => value.trim())) {
      if (!path.startsWith('/workspace/infra/operator/')) throw new Error();
      JSON.parse(await readFile(path, 'utf8'));
    }
  } catch { console.error(JSON.stringify({ code: 'SERVICE_CATALOG_FILE_MISSING_OR_INVALID', role })); process.exit(1); }
}
// Bounded availability/authentication checks only, never migrations, DB writes or runtime attestation.
const targets = ['web', 'control'].includes(role) ? [['api', 'qeynox-api', 4000]] : [
  ['postgres', new URL(process.env.DATABASE_URL).hostname, 5432],
  ['redis', new URL(process.env.QEYNOX_REDIS_URL).hostname, 6379],
  ['s3', 'qeynox-storage', 9000], ['hatchet-api', 'qeynox-hatchet', 8888],
  ['hatchet-grpc', 'qeynox-hatchet', 7077], ['hermes', 'qeynox-hermes', 8642],
  ...(role === 'worker' ? [['api', 'qeynox-api', 4000]] : []),
];
function reachable(host, port) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host, port });
    const finish = ok => { socket.destroy(); resolve(ok); };
    socket.setTimeout(2000, () => finish(false));
    socket.once('connect', () => finish(true)); socket.once('error', () => finish(false));
  });
}
let unavailable = [];
for (let attempt = 0; attempt < 12; attempt++) {
  unavailable = (await Promise.all(targets.map(async ([name, host, port]) => await reachable(host, port) ? null : name))).filter(Boolean);
  if (!unavailable.length) break;
  await new Promise(resolve => setTimeout(resolve, 2000));
}
if (unavailable.length) { console.error(JSON.stringify({ code: 'STARTUP_DEPENDENCIES_UNREACHABLE', role, dependencies: unavailable })); process.exit(1); }
if (['api', 'worker'].includes(role)) {
  const failures = [];
  const { Pool } = createRequire(new URL('../../apps/api/package.json', import.meta.url))('pg');
  const { createClient } = createRequire(new URL('../../packages/tools/package.json', import.meta.url))('redis');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5000, query_timeout: 5000 });
  pool.on('error', () => {});
  try { await pool.query('SELECT 1'); } catch { failures.push('postgres'); }
  finally { await pool.end(); }
  const redis = createClient({ url: process.env.QEYNOX_REDIS_URL, disableOfflineQueue: true, socket: { connectTimeout: 5000, reconnectStrategy: false } });
  redis.on('error', () => {});
  try { await redis.connect(); if (await redis.withCommandOptions({ abortSignal: AbortSignal.timeout(5000) }).ping() !== 'PONG') throw new Error(); }
  catch { failures.push('redis'); }
  finally { if (redis.isOpen) redis.destroy(); }
  if (failures.length) { console.error(JSON.stringify({ code: 'STARTUP_DEPENDENCY_AUTHENTICATION_FAILED', role, dependencies: failures })); process.exit(1); }
}
if (['web', 'control', 'worker'].includes(role)) {
  try {
    const response = await fetch('http://qeynox-api:4000/health', { redirect: 'error', signal: AbortSignal.timeout(5000) });
    const health = await response.json();
    if (!response.ok || health.release?.sha !== image.sha || health.release?.version !== image.version) throw new Error();
  } catch { console.error(JSON.stringify({ code: 'API_RELEASE_SKEW_OR_UNAVAILABLE', role })); process.exit(1); }
}
console.log(JSON.stringify({ code: 'STARTUP_DEPENDENCIES_REACHABLE', role, release: image, runtimeVerified: false }));

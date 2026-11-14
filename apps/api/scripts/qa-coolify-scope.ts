import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { CoolifyReadOnlyClient } from '../src/platform/coolify-readonly.client';
const requests: string[] = [];
const server = createServer((req, res) => {
  requests.push(req.url ?? '');
  res.setHeader('content-type', 'application/json');
  if (req.url === '/api/v1/projects/qeynox-project/preproduction') {
    res.end(JSON.stringify({ name: 'preproduction', applications: [{ uuid: 'app-1', name: 'qeynox-api', status: 'running:healthy' }], services: [{ uuid: 'svc-1', name: 'qeynox-storage' }] }));
  } else { res.statusCode = 404; res.end('{}'); }
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const address = server.address(); if (!address || typeof address === 'string') throw new Error('listen failed');
try {
  const base = `http://127.0.0.1:${address.port}`;
  const env = { QEYNOX_COOLIFY_BASE_URL: base, QEYNOX_COOLIFY_API_TOKEN: 'qa-token', QEYNOX_COOLIFY_PROJECT_UUID: 'qeynox-project', QEYNOX_COOLIFY_ENVIRONMENT: 'preproduction' };
  const unscoped = new CoolifyReadOnlyClient({ QEYNOX_COOLIFY_BASE_URL: base, QEYNOX_COOLIFY_API_TOKEN: 'qa-token' });
  assert.equal((await unscoped.list()).capability.status, 'NOT_CONFIGURED');
  const result = await new CoolifyReadOnlyClient(env).list();
  assert.equal(result.capability.status, 'CONFIGURED');
  assert.deepEqual(result.resources.map(x => [x.id, x.status]), [['app-1', 'running:healthy'], ['svc-1', 'unknown']]);
  assert.deepEqual(requests, ['/api/v1/projects/qeynox-project/preproduction']);
  console.log('Coolify scoped inventory: PASS');
} finally { server.close(); }

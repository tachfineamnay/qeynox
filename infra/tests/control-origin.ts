import assert from 'node:assert/strict';
import { apiOrigin } from '../../apps/web/src/lib/api-origin';
assert.equal(apiOrigin('http://qeynox-api:4000', 'http://qeynox-api:4000'), 'http://qeynox-api:4000/');
for (const value of ['http://qeynox-api:4001', 'http://evil:4000', 'http://user:pass@qeynox-api:4000', 'http://qeynox-api:4000/path']) assert.throws(() => apiOrigin(value, 'http://qeynox-api:4000'));
assert.throws(() => apiOrigin('http://qeynox-api:4000'));
console.log('Control private API origin: PASS');

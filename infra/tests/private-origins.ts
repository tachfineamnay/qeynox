import assert from 'node:assert/strict';
import { apiOrigin } from '../../apps/web/src/lib/api-origin';
import { hermesEndpoint } from '../../packages/engine/src/hermes-origin';
assert.equal(apiOrigin('http://qeynox-api:4000', 'http://qeynox-api:4000'), 'http://qeynox-api:4000/');
for (const url of ['http://qeynox-api:4001','http://evil:4000','http://qeynox-api:4000/path','http://user:pass@qeynox-api:4000']) {
 assert.throws(() => apiOrigin(url, 'http://qeynox-api:4000'));
}
assert.throws(() => apiOrigin('http://qeynox-api:4000'));
assert.equal(apiOrigin('https://api.example.org'), 'https://api.example.org/');
assert.equal(hermesEndpoint('http://qeynox-hermes:8642/v1/', 'http://qeynox-hermes:8642'), 'http://qeynox-hermes:8642/v1/chat/completions');
assert.throws(() => hermesEndpoint('http://other:8642/v1/', 'http://qeynox-hermes:8642'));
console.log('PASS: private origin authorization and Hermes wire path');

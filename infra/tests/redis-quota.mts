import assert from 'node:assert/strict';
import { RedisProviderRateLimiter } from '../../packages/tools/src/redis-rate-limit';
import { randomUUID } from 'node:crypto';
const url=process.env.QEYNOX_QA_REDIS_URL;
if(!url) throw new Error('QEYNOX_QA_REDIS_URL required');
const a=new RedisProviderRateLimiter(url), b=new RedisProviderRateLimiter(url);
try {
 const key='qa-'+randomUUID();
 const results=await Promise.allSettled(Array.from({length:12},(_,i)=>(i%2?a:b).check(key,3)));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,3);
 assert.equal(results.filter(r=>r.status==='rejected').length,9);
 await assert.rejects(a.check(key,0));
 const unavailable=new RedisProviderRateLimiter('redis://127.0.0.1:1');
 try { await assert.rejects(unavailable.check(key,3), /Shared provider quota is unavailable/); }
 finally { await unavailable.close(); }
 console.log('PASS: atomic shared Redis quota across independent clients');
} finally {await Promise.all([a.close(),b.close()]);}

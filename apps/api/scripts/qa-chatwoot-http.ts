import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { ChatwootClient } from '../src/support/chatwoot.client';
import { SupportService } from '../../../packages/application/src/support';
const directions: string[] = [];
const server = createServer(async (req,res) => {
  res.setHeader('content-type','application/json');
  if (req.headers.authorization !== 'Bearer qa-token') { res.statusCode=401; res.end('{}'); return; }
  if (req.url === '/api/v1/accounts/1/conversations/42' && req.method === 'GET') return void res.end(JSON.stringify({id:42,inbox_id:2,status:'open'}));
  if (req.url === '/api/v1/accounts/1/conversations/42/messages' && req.method === 'GET') return void res.end(JSON.stringify({payload:[{id:51,content:'hello',message_type:0,private:false}]}));
  if (req.url === '/api/v1/accounts/1/conversations/42/messages' && req.method === 'POST') {
    let text=''; for await (const chunk of req) text += chunk;
    const body=JSON.parse(text); directions.push(body.message_type); return void res.end(JSON.stringify({id:52,content:body.content,message_type:body.message_type,private:false}));
  }
  res.statusCode=404; res.end('{}');
});
server.listen(0,'127.0.0.1'); await once(server,'listening');
const addr=server.address(); if (!addr || typeof addr==='string') throw new Error('listen failed');
try {
  assert.equal(new ChatwootClient({}).capability.status,'NOT_CONFIGURED');
  const c = new ChatwootClient({QEYNOX_CHATWOOT_BASE_URL:`http://127.0.0.1:${addr.port}`, QEYNOX_CHATWOOT_API_TOKEN:'qa-token', QEYNOX_CHATWOOT_ACCOUNT_ID:'1', QEYNOX_CHATWOOT_INBOX_ID:'2'});
  assert.equal(c.capability.status, 'NOT_CONFIGURED');
  await assert.rejects(() => new SupportService(c, {} as any).open({userId:'user',workspaceId:'workspace',roles:[]} as any, 'hello'), (error: any) => error.code === 'NOT_CONFIGURED');
  assert.equal((await c.getConversation('42'))?.conversation.id,'42');
  assert.equal((await c.sendMessage('42','client','incoming')).id,'52');
  assert.equal((await c.sendMessage('42','team','outgoing')).id,'52');
  assert.deepEqual(directions,['incoming','outgoing']);
  console.log('Chatwoot HTTP response and direction: PASS');
} finally { server.close(); }

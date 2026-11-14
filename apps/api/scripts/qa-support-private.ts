import assert from 'node:assert/strict';
import { SupportService } from '../../../packages/application/src/support';
const port: any = { capability: {status:'CONFIGURED'}, getConversation: async () => ({ conversation: {id:'42'}, messages:[{id:'public',private:false},{id:'private',private:true}] }) };
const links: any = { findConversation: async () => ({id:'link'}) };
const service = new SupportService(port,links);
const result = await service.get({userId:'user',workspaceId:'workspace',roles:[]} as any,'42');
assert.deepEqual(result.messages.map(m => m.id), ['public']);
console.log('Chatwoot customer private note isolation: PASS');

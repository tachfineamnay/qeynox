import assert from 'node:assert/strict';
import { PlatformSupportService, SupportService } from '../../../packages/application/src/support';
import { DomainError } from '@qeynox/domain';

const calls: string[] = [];
const link = { id: 'link', userId: 'user', workspaceId: 'workspace', chatwootContactId: '1', chatwootConversationId: '10', createdAt: '', updatedAt: '' };
const conversation = (id: string) => ({ id, status: 'open', priority: null, inboxId: '1', createdAt: null, updatedAt: null, lastMessageAt: null, contact: { id: null, name: null, email: null }, assignee: null });
const port: any = {
  capability: { status: 'CONFIGURED' },
  listConversations: async () => [conversation('10'), conversation('99')],
  getConversation: async (id: string) => { calls.push('get:' + id); return { conversation: conversation(id), messages: [] }; },
  sendMessage: async (id: string, _content: string, direction: string) => { calls.push('send:' + id + ':' + direction); return {}; },
  updateStatus: async (id: string) => { calls.push('status:' + id); return conversation(id); },
};
const links: any = {
  listForConversations: async (ids: string[]) => ids.includes('10') ? [link] : [],
  listForUser: async () => [link], findConversation: async (_u: string, _w: string, id: string) => id === '10' ? link : undefined,
  touch: async () => {},
};
const platform: any = { requirePermission: async () => {}, recordAudit: async () => {} };
const principal: any = { userId: 'agent' };
const customer: any = { userId: 'user', workspaceId: 'workspace' };
const support = new PlatformSupportService(port, links, platform);
assert.deepEqual((await support.list(principal, {})).map(x => x.conversation.id), ['10']);
for (const fn of [() => support.get(principal, '99'), () => support.reply(principal, '99', 'hello'), () => support.updateStatus(principal, '99', 'resolved')]) {
  await assert.rejects(fn, (e: unknown) => e instanceof DomainError && e.code === 'NOT_FOUND');
}
assert.equal(calls.length, 0);
await support.reply(principal, '10', 'hello');
assert.ok(calls.includes('send:10:outgoing'));
const mine = new SupportService(port, links);
await mine.reply(customer, '10', 'hello');
assert.ok(calls.includes('send:10:incoming'));
port.getConversation = async () => { throw new DomainError('UNAVAILABLE', 'upstream down'); };
await assert.rejects(() => mine.listMine(customer), (e: unknown) => e instanceof DomainError && e.code === 'UNAVAILABLE');
console.log('support isolation, message direction and outage propagation: PASS');

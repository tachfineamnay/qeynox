/**
 * Support isolation and direction contract checks (in-memory port stub; fixture only).
 *
 * A customer can only reach conversations explicitly mapped to their identity AND active workspace;
 * orphaned or ambiguously mapped (duplicate) links authorize nothing. Platform operators see only
 * conversations with an explicit link, and every mutation is outgoing/incoming as appropriate.
 * These checks never touch a network or a database.
 */
import assert from 'node:assert/strict';
import { PlatformSupportService, SupportService } from '../../../packages/application/src/support';
import { DomainError } from '@qeynox/domain';

const calls: string[] = [];
const link = { id: 'link', userId: 'user', workspaceId: 'workspace', chatwootContactId: '1', chatwootConversationId: '10', state: 'ACTIVE' as const, createdAt: '', updatedAt: '' };
const orphan = { ...link, id: 'orphan-link', chatwootConversationId: '77', state: 'ORPHANED' as const };
const conversation = (id: string) => ({ id, status: 'open', priority: null, inboxId: '1', createdAt: null, updatedAt: null, lastMessageAt: null, contact: { id: null, name: null, email: null }, assignee: null });
const port: any = {
  capability: { status: 'CONFIGURED', reason: null, inboxConfigured: true, webhooksRequired: false },
  listConversations: async () => ({ conversations: [conversation('10'), conversation('99')], page: 1, perPage: 25, totalCount: 2, hasMore: false }),
  getConversation: async (id: string) => { calls.push('get:' + id); return { conversation: conversation(id), messages: [] }; },
  sendMessage: async (id: string, _content: string, direction: string) => { calls.push('send:' + id + ':' + direction); return { id: 'msg-' + calls.length, content: 'x', messageType: direction, private: false, sourceId: null, createdAt: new Date(0).toISOString(), sender: null }; },
  updateStatus: async (id: string) => { calls.push('status:' + id); },
};
const links: any = {
  listForConversations: async (ids: string[]) => ids.includes('10') ? [link] : ids.includes('77') ? [orphan] : [],
  listForUser: async () => [link, orphan],
  findConversation: async (_u: string, _w: string, id: string) => id === '10' ? link : (id === '77' ? orphan : undefined),
  findDuplicatedConversationIds: async () => new Set<string>(),
  touch: async () => {},
  markOrphaned: async () => {},
};
const platform: any = { requirePermission: async () => {}, recordAudit: async () => {}, recordInputRejection: async () => {} };
const principal: any = { userId: 'agent', sessionId: 'session' };
const customer: any = { userId: 'user', workspaceId: 'workspace', roles: [] };

const support = new PlatformSupportService(port, links, platform);
const list = await support.list(principal, {});
assert.deepEqual(list.items.map(x => x.conversation.id), ['10']);
assert.equal(list.page, 1);
assert.equal(list.totalCount, 2);
assert.equal(list.hasMore, false);
for (const fn of [
  () => support.get(principal, '99'),
  () => support.reply(principal, '99', 'hello there', { reason: 'ten characters at least' }),
  () => support.updateStatus(principal, '99', 'resolved', { reason: 'ten characters at least' }),
]) {
  await assert.rejects(fn, (e: unknown) => e instanceof DomainError && e.code === 'NOT_FOUND');
}
// Orphaned customer link authorizes nothing for reading either.
await assert.rejects(() => new SupportService(port, links).get(customer, '77'), (e: unknown) => e instanceof DomainError && e.code === 'NOT_FOUND');
assert.equal(calls.length, 0);
await support.reply(principal, '10', 'hello operator', { reason: 'ten characters at least' });
assert.ok(calls.includes('send:10:outgoing'));
const mine = new SupportService(port, links);
await mine.reply(customer, '10', 'hello customer');
assert.ok(calls.includes('send:10:incoming'));

// Ambiguous (duplicate) mapping fails closed on every surface.
const duplicatedLinks: any = { ...links, findDuplicatedConversationIds: async () => new Set(['10']) };
await assert.rejects(() => new SupportService(port, duplicatedLinks).get(customer, '10'), (e: unknown) => e instanceof DomainError && e.code === 'CONFLICT');
await assert.rejects(() => new PlatformSupportService(port, duplicatedLinks, platform).get(principal, '10'), (e: unknown) => e instanceof DomainError && e.code === 'CONFLICT');
assert.equal((await new PlatformSupportService(port, duplicatedLinks, platform).list(principal, {})).items.length, 0);

// A remote 404 marks the customer link orphaned and authorizes nothing afterwards.
const vanishingPort: any = { ...port, getConversation: async (id: string) => (id === '10' ? null : { conversation: conversation(id), messages: [] }) };
let marked: string | null = null;
const orphaningLinks: any = { ...links, listForUser: async () => [link], markOrphaned: async (id: string) => { marked = id; } };
const orphaned = await new SupportService(vanishingPort, orphaningLinks).listMine(customer);
assert.deepEqual(orphaned, []);
assert.equal(marked, 'link');

port.getConversation = async () => { throw new DomainError('UNAVAILABLE', 'upstream down'); };
await assert.rejects(() => mine.listMine(customer), (e: unknown) => e instanceof DomainError && e.code === 'UNAVAILABLE');
console.log('support isolation, orphan handling, duplicate fail-closed, direction and outage propagation: PASS (fixture only — not a live Chatwoot check)');

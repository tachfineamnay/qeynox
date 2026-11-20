/**
 * Customer private-note non-disclosure checks (in-memory port stub; fixture only).
 *
 * The customer surface must only see explicitly public incoming/outgoing messages. Activity and
 * template entries are hidden, and any message whose visibility flag is missing or not exactly
 * false is treated as private.
 */
import assert from 'node:assert/strict';
import { SupportService } from '../../../packages/application/src/support';

const mk = (id: string, messageType: string, visible: boolean | undefined) => ({
  id, content: 'content of ' + id, messageType,
  private: visible === false ? false : true, // mirrors the adapter normalization
  sourceId: null, createdAt: new Date(0).toISOString(), sender: null,
});
const port: any = {
  capability: { status: 'CONFIGURED', reason: null, inboxConfigured: true, webhooksRequired: false },
  getConversation: async () => ({
    conversation: { id: '42', status: 'open', priority: null, inboxId: '2', createdAt: null, updatedAt: null, lastMessageAt: null, contact: { id: null, name: null, email: null }, assignee: null },
    messages: [
      mk('public-incoming', 'incoming', false),
      mk('public-outgoing', 'outgoing', false),
      mk('private-note', 'outgoing', true),
      mk('activity', 'activity', false),
      mk('template', 'template', false),
      mk('unknown-visibility', 'incoming', undefined),
    ],
  }),
};
const links: any = {
  findConversation: async () => ({ id: 'link', userId: 'user', workspaceId: 'workspace', chatwootContactId: '1', chatwootConversationId: '42', state: 'ACTIVE', createdAt: '', updatedAt: '' }),
  findDuplicatedConversationIds: async () => new Set<string>(),
};
const service = new SupportService(port, links);
const result = await service.get({ userId: 'user', workspaceId: 'workspace', roles: [] } as any, '42');
assert.deepEqual(result.messages.map(m => m.id), ['public-incoming', 'public-outgoing']);
console.log('Chatwoot customer private note isolation: PASS (fixture only — not a live Chatwoot check)');

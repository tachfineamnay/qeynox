/**
 * Support concurrency QA (fixture server only).
 *
 * Two simultaneous opens carrying the same idempotency key must yield exactly one remote conversation,
 * one first message and one authorization link — even when the remote create's response is lost after
 * the write landed. Sequential different-key concurrency must simply create two independent threads.
 *
 * PASS here does NOT mean the live integration works; see docs/architecture/CHATWOOT_SUPPORT.md.
 */
import assert from 'node:assert/strict';
import { createChatwootFixture } from './support-chatwoot-fixture';
import { ChatwootClient } from '../src/support/chatwoot.client';
import { SupportService } from '../../../packages/application/src/support';
import type { ID, Principal, SupportIntent } from '@qeynox/domain';

const customer: Principal = { userId: 'user-1' as ID, workspaceId: 'workspace-1' as ID, roles: ['MEMBER'] };
const id = (value: string): ID => value as ID;
let assertions = 0;
function assertOk(condition: unknown, message: string): asserts condition {
  assertions++;
  if (!condition) throw new Error('ASSERTION FAILED: ' + message);
}

function createMemoryLinks() {
  const intents = new Map<string, SupportIntent>();
  const intentByRef = new Map<string, string>();
  const links: Array<{
    id: string; userId: string; workspaceId: string; chatwootContactId: string;
    chatwootConversationId: string; state: 'ACTIVE' | 'ORPHANED'; createdAt: string; updatedAt: string;
  }> = [];
  const profiles = new Map([[ 'user-1', { email: 'qa-customer@example.invalid', displayName: 'QA Customer', workspaceName: 'QA Workspace' } ]]);
  return {
    intents, links,
    async findContact(userId: string, workspaceId: string) {
      const found = links.find(link => link.userId === userId && link.workspaceId === workspaceId);
      return found ? { ...found } : undefined;
    },
    async findConversation(userId: string, workspaceId: string, chatwootConversationId: string) {
      const found = links.find(link => link.userId === userId && link.workspaceId === workspaceId && link.chatwootConversationId === chatwootConversationId);
      return found ? { ...found } : undefined;
    },
    async listForUser(userId: string, workspaceId: string) { return links.filter(link => link.userId === userId && link.workspaceId === workspaceId).map(link => ({ ...link })); },
    async listForConversations(ids: readonly string[]) { return links.filter(link => ids.includes(link.chatwootConversationId)).map(link => ({ ...link })); },
    async findDuplicatedConversationIds(ids: readonly string[]) {
      const counts = new Map<string, Set<string>>();
      for (const link of links) {
        if (!ids.includes(link.chatwootConversationId)) continue;
        const set = counts.get(link.chatwootConversationId) ?? new Set<string>();
        set.add(link.userId + ':' + link.workspaceId);
        counts.set(link.chatwootConversationId, set);
      }
      return new Set([...counts.entries()].filter(([, pairs]) => pairs.size > 1).map(([k]) => k));
    },
    async createIntent(input: { id: string; userId: string; workspaceId: string; intentRef: string; at: Date }) {
      const existingId = intentByRef.get(input.intentRef);
      if (existingId) return { created: false, intent: intents.get(existingId) as SupportIntent };
      const intent: SupportIntent = {
        id: id(input.id), userId: id(input.userId), workspaceId: id(input.workspaceId), intentRef: input.intentRef,
        chatwootContactId: null, chatwootConversationId: null, state: 'PENDING_CONTACT', failureCode: null,
        createdAt: input.at.toISOString(), updatedAt: input.at.toISOString(),
      };
      intents.set(intent.id, intent);
      intentByRef.set(intent.intentRef, intent.id);
      return { created: true, intent };
    },
    async findIntentByRef(userId: string, workspaceId: string, intentRef: string) {
      const found = intentByRef.get(intentRef);
      return found ? intents.get(found) : undefined;
    },
    async updateIntent(intentId: string, input: Partial<SupportIntent> & { state: SupportIntent['state']; at: Date }) {
      const intent = intents.get(intentId);
      if (!intent) throw new Error('intent not found');
      intents.set(intentId, {
        ...intent,
        state: input.state,
        chatwootContactId: input.chatwootContactId === undefined ? intent.chatwootContactId : input.chatwootContactId,
        chatwootConversationId: input.chatwootConversationId === undefined ? intent.chatwootConversationId : input.chatwootConversationId,
        failureCode: input.failureCode === undefined ? intent.failureCode : input.failureCode,
        updatedAt: input.at.toISOString(),
      });
    },
    async createLink(input: { id: string; userId: string; workspaceId: string; chatwootContactId: string; chatwootConversationId: string; at: Date; intentId?: string }) {
      const link = {
        id: input.id, userId: input.userId, workspaceId: input.workspaceId,
        chatwootContactId: input.chatwootContactId, chatwootConversationId: input.chatwootConversationId,
        state: 'ACTIVE' as const, createdAt: input.at.toISOString(), updatedAt: input.at.toISOString(),
      };
      links.push(link);
      if (input.intentId) {
        const intent = intents.get(input.intentId);
        if (intent) intents.set(input.intentId, { ...intent, state: 'LINKED', chatwootContactId: input.chatwootContactId, chatwootConversationId: input.chatwootConversationId, updatedAt: input.at.toISOString() });
      }
      return { ...link };
    },
    async markOrphaned(linkId: string) {
      const link = links.find(item => item.id === linkId);
      if (link) link.state = 'ORPHANED';
    },
    async touch() { /* no-op */ },
    async actorProfile(userId: string) { return profiles.get(userId); },
  };
}

const fixture = await createChatwootFixture();
try {
  const env = {
    QEYNOX_CHATWOOT_BASE_URL: fixture.url, QEYNOX_CHATWOOT_API_TOKEN: 'qa-token',
    QEYNOX_CHATWOOT_ACCOUNT_ID: '1', QEYNOX_CHATWOOT_INBOX_ID: '2', QEYNOX_CHATWOOT_LIVE_VERIFIED: 'true',
  };
  const client = new ChatwootClient(env);

  // ---- scenario 1: clean double-click ------------------------------------------------------
  {
    const links = createMemoryLinks();
    const service = new SupportService(client as any, links as any);
    const [first, second] = await Promise.all([
      service.open(customer, 'Double invoice charge', { requestId: 'req-concurrent-0001' }),
      service.open(customer, 'Double invoice charge', { requestId: 'req-concurrent-0001' }),
    ]);
    assertOk(first.conversation.id === second.conversation.id, 'both calls resolve to the same conversation');
    assertOk(fixture.conversations.filter(item => item.sourceId === 'req-concurrent-0001').length === 1, 'exactly one remote conversation');
    assertOk(fixture.messages.filter(message => message.sourceId === 'req-concurrent-0001:first').length === 1, 'exactly one first message');
    assertOk(links.links.length === 1, 'exactly one authorization link');
  }

  // ---- scenario 2: response lost after the remote write landed -----------------------------
  {
    const links = createMemoryLinks();
    const service = new SupportService(client as any, links as any);
    fixture.arm('fail-500-after-conversation-create');
    const [first, second] = await Promise.all([
      service.open(customer, 'Crash on create', { requestId: 'req-concurrent-0002' }),
      service.open(customer, 'Crash on create', { requestId: 'req-concurrent-0002' }),
    ]);
    assertOk(first.conversation.id === second.conversation.id, 'twin requests converge on the remotely-created conversation');
    assertOk(fixture.conversations.filter(item => item.sourceId === 'req-concurrent-0002').length === 1, 'the ambiguous write produced exactly one conversation');
    assertOk(links.links.length === 1, 'exactly one authorization link after recovery');
  }

  // ---- scenario 3: response lost after the first message landed ----------------------------
  {
    const links = createMemoryLinks();
    const service = new SupportService(client as any, links as any);
    fixture.arm('crash-after-message-create');
    const [first, second] = await Promise.all([
      service.open(customer, 'Crash on message', { requestId: 'req-concurrent-0003' }),
      service.open(customer, 'Crash on message', { requestId: 'req-concurrent-0003' }),
    ]);
    assertOk(first.conversation.id === second.conversation.id, 'both calls resolve to the same conversation');
    assertOk(fixture.messages.filter(message => message.sourceId === 'req-concurrent-0003:first').length === 1, 'the ambiguously-sent message exists exactly once');
  }

  // ---- scenario 4: different keys stay independent threads ----------------------------------
  {
    const links = createMemoryLinks();
    const service = new SupportService(client as any, links as any);
    const [first, second] = await Promise.all([
      service.open(customer, 'First unrelated issue', { requestId: 'req-concurrent-0004a' }),
      service.open(customer, 'Second unrelated issue', { requestId: 'req-concurrent-0004b' }),
    ]);
    assertOk(first.conversation.id !== second.conversation.id, 'different requestIds open independent conversations');
    assertOk(links.links.length === 2, 'two links for two threads');
  }

  console.log('Support concurrency: PASS — ' + assertions + ' assertions (fixture only; NOT a live Chatwoot verification)');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await fixture.close();
}

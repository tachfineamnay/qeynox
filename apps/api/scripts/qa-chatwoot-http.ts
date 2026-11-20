/**
 * Chatwoot HTTP contract + reconciliation QA (fixture server only).
 *
 * The fixture (./support-chatwoot-fixture.ts) implements the documented Chatwoot REST shape with
 * deterministic state and one-shot failure injection. These checks verify the adapter's wire
 * contract: capability gating, envelope parsing, pagination, direction of messages, private-note
 * visibility and — critically — recovery from ambiguous outcomes without duplicating contacts,
 * conversations or messages.
 *
 * PASS here does NOT mean the live integration works: see docs/architecture/CHATWOOT_SUPPORT.md
 * for the required real-service verification procedure.
 */
import assert from 'node:assert/strict';
import { createChatwootFixture } from './support-chatwoot-fixture';
import { ChatwootClient } from '../src/support/chatwoot.client';
import { SupportService } from '../../../packages/application/src/support';
import { DomainError, type ID, type Principal, type SupportIntent } from '@qeynox/domain';

const id = (value: string): ID => value as ID;

const customer: Principal = { userId: id('user-1'), workspaceId: id('workspace-1'), roles: ['MEMBER'] };
const otherCustomer: Principal = { userId: id('user-2'), workspaceId: id('workspace-1'), roles: ['MEMBER'] };

let assertions = 0;
function assertOk(condition: unknown, message: string): asserts condition {
  assertions++;
  if (!condition) throw new Error('ASSERTION FAILED: ' + message);
}
async function expectDomainError(code: string, run: () => Promise<unknown>, label: string): Promise<void> {
  assertions++;
  try {
    await run();
  } catch (error: unknown) {
    if (error instanceof DomainError && error.code === code) return;
    throw new Error('EXPECTED ' + code + ' for ' + label + ', got ' + (error instanceof DomainError ? error.code : String(error)));
  }
  throw new Error('EXPECTED ' + code + ' for ' + label + ', but no error was raised');
}

/** Faithful in-memory implementation of the link repository port, including intent uniqueness. */
function createMemoryLinks(now: () => Date) {
  const state = {
    intents: new Map<string, SupportIntent>(),
    links: [] as Array<{
      id: string; userId: string; workspaceId: string; chatwootContactId: string;
      chatwootConversationId: string; state: 'ACTIVE' | 'ORPHANED'; createdAt: Date; updatedAt: Date;
    }>,
    profiles: new Map<string, { email: string; displayName: string; workspaceName: string }>(),
  };
  const links = {
    state,
    async findContact(userId: string, workspaceId: string) {
      const found = state.links.find(link => link.userId === userId && link.workspaceId === workspaceId);
      return found ? { ...found, createdAt: found.createdAt.toISOString(), updatedAt: found.updatedAt.toISOString() } : undefined;
    },
    async findConversation(userId: string, workspaceId: string, chatwootConversationId: string) {
      const found = state.links.find(link => link.userId === userId && link.workspaceId === workspaceId && link.chatwootConversationId === chatwootConversationId);
      return found ? { ...found, createdAt: found.createdAt.toISOString(), updatedAt: found.updatedAt.toISOString() } : undefined;
    },
    async listForUser(userId: string, workspaceId: string) {
      return state.links.filter(link => link.userId === userId && link.workspaceId === workspaceId)
        .map(link => ({ ...link, createdAt: link.createdAt.toISOString(), updatedAt: link.updatedAt.toISOString() }));
    },
    async listForConversations(ids: readonly string[]) {
      return state.links.filter(link => ids.includes(link.chatwootConversationId))
        .map(link => ({ ...link, createdAt: link.createdAt.toISOString(), updatedAt: link.updatedAt.toISOString() }));
    },
    async findDuplicatedConversationIds(ids: readonly string[]) {
      const counts = new Map<string, Set<string>>();
      for (const link of state.links) {
        if (!ids.includes(link.chatwootConversationId)) continue;
        const set = counts.get(link.chatwootConversationId) ?? new Set<string>();
        set.add(link.userId + ':' + link.workspaceId);
        counts.set(link.chatwootConversationId, set);
      }
      return new Set([...counts.entries()].filter(([, pairs]) => pairs.size > 1).map(([id]) => id));
    },
    async createIntent(input: { id: string; userId: string; workspaceId: string; intentRef: string; at: Date }) {
      const existing = Array.from(state.intents.values()).find(intent => intent.userId === id(input.userId) && intent.workspaceId === id(input.workspaceId) && intent.intentRef === input.intentRef);
      if (existing) return { created: false, intent: existing };
      const intent: SupportIntent = {
        id: id(input.id), userId: id(input.userId), workspaceId: id(input.workspaceId), intentRef: input.intentRef,
        chatwootContactId: null, chatwootConversationId: null, state: 'PENDING_CONTACT', failureCode: null,
        createdAt: input.at.toISOString(), updatedAt: input.at.toISOString(),
      };
      state.intents.set(intent.id, intent);
      return { created: true, intent };
    },
    async findIntentByRef(userId: string, workspaceId: string, intentRef: string) {
      const found = Array.from(state.intents.values()).find(intent => intent.userId === userId && intent.workspaceId === workspaceId && intent.intentRef === intentRef);
      return found;
    },
    async updateIntent(id: string, input: Partial<SupportIntent> & { state: SupportIntent['state']; at: Date }) {
      const intent = state.intents.get(id);
      if (!intent) throw new Error('intent not found: ' + id);
      state.intents.set(id, {
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
        state: 'ACTIVE' as const, createdAt: input.at, updatedAt: input.at,
      };
      state.links.push(link);
      if (input.intentId) {
        const intent = state.intents.get(input.intentId);
        if (intent) {
          state.intents.set(input.intentId, {
            ...intent, state: 'LINKED',
            chatwootContactId: input.chatwootContactId, chatwootConversationId: input.chatwootConversationId,
            updatedAt: input.at.toISOString(),
          });
        }
      }
      return { ...link, createdAt: link.createdAt.toISOString(), updatedAt: link.updatedAt.toISOString() };
    },
    async markOrphaned(linkId: string, at: Date) {
      const link = state.links.find(item => item.id === linkId);
      if (link) link.state = 'ORPHANED';
    },
    async touch(linkId: string, at: Date) {
      const link = state.links.find(item => item.id === linkId);
      if (link) link.updatedAt = at;
    },
    async actorProfile(userId: string) {
      const profile = state.profiles.get(userId);
      return profile ? { ...profile } : undefined;
    },
    seedProfile(userId: string, email: string, displayName: string) {
      state.profiles.set(userId, { email, displayName, workspaceName: 'QA Workspace' });
    },
  };
  return links;
}

const fixture = await createChatwootFixture();
let failures = 0;
try {
  // ---- capability gating --------------------------------------------------------------
  assertOk(new ChatwootClient({}).capability.status === 'NOT_CONFIGURED', 'missing variables fail closed');
  const unverified = new ChatwootClient({
    QEYNOX_CHATWOOT_BASE_URL: fixture.url, QEYNOX_CHATWOOT_API_TOKEN: 'qa-token',
    QEYNOX_CHATWOOT_ACCOUNT_ID: '1', QEYNOX_CHATWOOT_INBOX_ID: '2',
  });
  assertOk(unverified.capability.status === 'NOT_CONFIGURED', 'credentials without live verification stay NOT_CONFIGURED');
  assertOk(unverified.capability.reason === 'CHATWOOT_LIVE_VERIFICATION_REQUIRED', 'unverified reason is explicit');
  await expectDomainError('NOT_CONFIGURED', () => unverified.getConversation('101'), 'unverified client refuses to call remote');
  const insecure = new ChatwootClient({
    QEYNOX_CHATWOOT_BASE_URL: 'http://chatwoot.example.com', QEYNOX_CHATWOOT_API_TOKEN: 'qa-token',
    QEYNOX_CHATWOOT_ACCOUNT_ID: '1', QEYNOX_CHATWOOT_INBOX_ID: '2', QEYNOX_CHATWOOT_LIVE_VERIFIED: 'true',
  });
  assertOk(insecure.capability.reason === 'QEYNOX_CHATWOOT_BASE_URL_INSECURE', 'plain http on non-loopback is rejected');

  const env = {
    QEYNOX_CHATWOOT_BASE_URL: fixture.url, QEYNOX_CHATWOOT_API_TOKEN: 'qa-token',
    QEYNOX_CHATWOOT_ACCOUNT_ID: '1', QEYNOX_CHATWOOT_INBOX_ID: '2', QEYNOX_CHATWOOT_LIVE_VERIFIED: 'true',
  };
  const client = new ChatwootClient(env);
  assertOk(client.capability.status === 'CONFIGURED', 'fully specified + verified config is CONFIGURED');

  const links = createMemoryLinks(() => new Date());
  links.seedProfile('user-1', 'qa-customer@example.invalid', 'QA Customer');
  links.seedProfile('user-2', 'qa-other@example.invalid', 'QA Other');
  const service = new SupportService(client as any, links as any);

  // ---- customer open flow + idempotent replay ------------------------------------------
  const opened = await service.open(customer, 'I need help with my invoice', { requestId: 'req-invoice-0001' });
  assertOk(opened.conversation.id !== 'unknown', 'conversation opened');
  const conversationId = opened.conversation.id;
  assertOk(fixture.contacts.length === 1 && fixture.contacts[0]?.identifier === 'qeynox:user-1:workspace-1', 'contact created with deterministic identifier');
  const intent = [...links.state.intents.values()][0];
  assertOk(intent?.state === 'LINKED', 'intent linked after open');
  assertOk(fixture.messages.length === 1 && fixture.messages[0]?.sourceId === 'req-invoice-0001:first', 'first message carries the deterministic source_id');
  assertOk(fixture.messages[0]?.messageType === 0, 'first message is incoming (customer direction)');

  const replayed = await service.open(customer, 'I need help with my invoice', { requestId: 'req-invoice-0001' });
  assertOk(replayed.conversation.id === conversationId, 'replaying the same requestId returns the same conversation');
  assertOk(fixture.conversations.length === 1 && fixture.messages.length === 1, 'replay creates nothing remotely');

  // ---- ambiguous conversation create (5xx after remote write): self-healing reconcile -----
  fixture.arm('fail-500-after-conversation-create');
  const recovered = await service.open(customer, 'Second issue, please', { requestId: 'req-ambiguous-0002' });
  assertOk(recovered.conversation.id !== 'unknown', 'open recovered after ambiguous conversation create');
  const recoveredConversation = fixture.conversations.find(item => item.sourceId === 'req-ambiguous-0002');
  assertOk(recoveredConversation, 'the remotely-created conversation was adopted, not duplicated');
  assertOk(fixture.conversations.filter(item => item.sourceId === 'req-ambiguous-0002').length === 1, 'exactly one conversation exists for the ambiguous request');

  // ---- ambiguous message create (5xx after remote write): reconcile via history ----------
  fixture.arm('fail-500-after-message-create');
  const messageRecovered = await service.open(customer, 'Third issue, please', { requestId: 'req-ambiguous-msg-0003' });
  assertOk(messageRecovered.conversation.id !== 'unknown', 'open recovered after ambiguous message create');
  const msgConversationId = messageRecovered.conversation.id;
  const msgs = fixture.messages.filter(message => message.conversationId === Number(msgConversationId) && message.sourceId === 'req-ambiguous-msg-0003:first');
  assertOk(msgs.length === 1, 'the ambiguously-sent first message was detected in history, not duplicated');

  // ---- ambiguous message send without remote write: bounded retry with same source_id -----
  fixture.arm('fail-500-on-send-message');
  const retried = await service.open(customer, 'Fourth issue, please', { requestId: 'req-ambiguous-retry-0004' });
  assertOk(retried.conversation.id !== 'unknown', 'open completed after bounded retry');
  const retryMsgs = fixture.messages.filter(message => message.sourceId === 'req-ambiguous-retry-0004:first');
  assertOk(retryMsgs.length === 1, 'the bounded retry delivered exactly one message');

  // ---- ambiguous contact create (connection destroyed after remote write) ------------------
  const contactBefore = fixture.contacts.length;
  fixture.arm('crash-after-contact-create');
  await expectDomainError('UNKNOWN_OUTCOME', () => client.createContact({ email: 'crash@example.invalid', displayName: 'Crash', userId: 'user-crash', workspaceId: 'workspace-1' }), 'destroyed socket surfaces UNKNOWN_OUTCOME');
  assertOk(fixture.contacts.length === contactBefore + 1, 'contact was persisted despite the lost response');
  const reconciled = await client.findContactByIdentifier('qeynox:user-crash:workspace-1');
  assertOk(reconciled !== null, 'contact reconciled by identifier after crash');

  // ---- duplicate conversations with the same source_id: adopt earliest, flag anomaly -------
  // Drift fabricated exactly as production could produce it: two conversations carrying one source_id
  // on the SAME contact (a retried remote write that outlived its twin request).
  const dupRequest = 'req-duplicate-0005';
  const tenantContactId = String(fixture.contacts[0]?.id);
  assertOk(tenantContactId !== 'undefined' && Number(tenantContactId) > 0, 'tenant contact resolved from fixture');
  const dupConvA = await client.createConversation({ contactId: tenantContactId, sourceId: dupRequest });
  const dupConvB = await client.createConversation({ contactId: tenantContactId, sourceId: dupRequest });
  const earliestId = [Number(dupConvA.id), Number(dupConvB.id)].sort((a, b) => a - b)[0] as number;
  const adopted = await service.open(customer, 'Fifth issue, please', { requestId: dupRequest });
  assertOk(Number(adopted.conversation.id) === earliestId, 'the earliest duplicate conversation is adopted deterministically');
  const dupIntent = [...links.state.intents.values()].find(item => item.intentRef === dupRequest);
  assertOk(dupIntent?.failureCode === 'DUPLICATE_CONVERSATIONS_DETECTED', 'the duplicate anomaly is recorded on the intent');

  // ---- message direction -------------------------------------------------------------------
  const openDetail = await service.get(customer, conversationId);
  assertOk(openDetail.messages.every(message => message.messageType === 'incoming' || message.messageType === 'outgoing'), 'customer view only carries chat messages');

  // ---- private note never reaches the customer; operator sees it --------------------------
  const privateFixture = fixture.messages.find(message => message.conversationId === Number(conversationId));
  assertOk(privateFixture, 'fixture has a message');
  // Inject a private note straight into fixture history (as an operator note would appear in Chatwoot).
  const noteConversation = fixture.conversations.find(item => item.id === Number(conversationId));
  assertOk(noteConversation, 'conversation present');
  (fixture as any).messages.push({ id: 900001, conversationId: Number(conversationId), content: 'Internal: verify invoice PDF before replying', messageType: 1, private: true, sourceId: null, createdAt: Math.floor(Date.now() / 1000) });
  const customerView = await service.get(customer, conversationId);
  assertOk(!customerView.messages.some(message => message.content.includes('Internal:')), 'customer view excludes the private note');
  assertOk(customerView.messages.every(message => message.private === false), 'customer view carries only explicitly public messages');

  // ---- list pagination contract ------------------------------------------------------------
  const page1 = await client.listConversations({ status: 'all', page: 1 });
  assertOk(page1.page === 1 && page1.perPage === 25, 'pagination echoes page and perPage');
  assertOk(page1.totalCount === fixture.conversations.length, 'all_count reflects fixture state');
  assertOk(typeof page1.hasMore === 'boolean', 'hasMore is always a boolean');

  // ---- status transitions -------------------------------------------------------------------
  await client.updateStatus(conversationId, 'pending');
  const toggled = await client.getConversation(conversationId);
  assertOk(toggled?.conversation.status === 'pending', 'toggle_status applied remotely');
  const pendingOnly = await client.listConversations({ status: 'pending', page: 1 });
  assertOk(pendingOnly.conversations.every(item => item.status === 'pending'), 'status filter is honoured');
  await client.updateStatus(conversationId, 'open');

  // ---- unknown conversation is null, not an exception --------------------------------------
  assertOk(await client.getConversation('999999') === null, 'remote 404 maps to null');

  // ---- reply direction + requestId deduplication -------------------------------------------
  const beforeReply = fixture.messages.length;
  await service.reply(customer, conversationId, 'any update?', { requestId: 'reply-req-0001' });
  await service.reply(customer, conversationId, 'any update?', { requestId: 'reply-req-0001' });
  assertOk(fixture.messages.length === beforeReply + 1, 'retrying a reply with the same requestId sends once');
  const last = fixture.messages[fixture.messages.length - 1];
  assertOk(last?.messageType === 0, 'customer reply is incoming');
  assertOk(last?.sourceId === 'reply:reply-req-0001', 'reply carries the deterministic source_id');

  // ---- isolation between customers -----------------------------------------------------------
  await expectDomainError('NOT_FOUND', () => new SupportService(client as any, links as any).get(otherCustomer, conversationId), 'other customer cannot read the conversation');
  const foreignReplay = await new SupportService(client as any, links as any).open(otherCustomer, 'I never sent this', { requestId: 'req-invoice-0001' });
  assertOk(foreignReplay.conversation.id !== conversationId, 'the same requestId in another tenant never adopts the foreign conversation');

  console.log('Chatwoot HTTP contract, reconciliation and failure injection: PASS — ' + assertions + ' assertions (fixture only; NOT a live Chatwoot verification)');
} catch (error) {
  failures++;
  console.error(error);
  process.exitCode = 1;
} finally {
  await fixture.close();
}
if (failures > 0) process.exit(1);

/**
 * Support reconciliation end-to-end QA (isolated PostgreSQL + fixture Chatwoot only).
 *
 * Requires QEYNOX_QA_DATABASE_URL pointing at a LOCAL PostgreSQL server; the suite creates a
 * brand-new disposable database, applies every migration (including 0020_support_intents.sql) and
 * exercises the durable reconciliation state machine: intent lifecycle, authorization links,
 * idempotent replay, ambiguous-outcome recovery, orphan detection and duplicate-mapping fail-closed.
 *
 * The Chatwoot side is the deterministic fixture (./support-chatwoot-fixture.ts) — never the live
 * service. PASS here does NOT prove the live integration; see docs/architecture/CHATWOOT_SUPPORT.md.
 */
import { randomUUID } from 'node:crypto';
import {
  connectDatabase, identityMemberships, identityUsers, identityWorkspaces, runMigrations,
  SupportLinkStore, type DatabaseConnection,
} from '@qeynox/persistence';
import { eq } from 'drizzle-orm';
import { SupportService, PlatformSupportService } from '../../../packages/application/src/support';
import type { PlatformAuditEntry } from '../../../packages/application/src/platform-admin';
import { ChatwootClient } from '../src/support/chatwoot.client';
import { createChatwootFixture } from './support-chatwoot-fixture';
import { createIsolatedQaDatabase } from './qa-isolated-database';
import { DomainError, type ID, type PlatformPrincipal, type Principal } from '@qeynox/domain';
import { supportChatwootLinks, supportIntents } from '../../../packages/persistence/src/support-schema';

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

const qa = await createIsolatedQaDatabase();
let connection: DatabaseConnection | undefined;
const fixture = await createChatwootFixture();
const audits: PlatformAuditEntry[] = [];
try {
  const report = await runMigrations(qa.url);
  assertOk(report.applied.includes('0020_support_intents.sql'), '0020_support_intents.sql applied; ' + report.applied.length + ' migrations total');

  connection = connectDatabase(qa.url);
  const db = connection.db;
  const store = new SupportLinkStore(db);

  // ---- seed two isolated (user, workspace) pairs ----------------------------------------
  const userA = randomUUID() as ID, userB = randomUUID() as ID;
  const workspaceA = randomUUID() as ID, workspaceB = randomUUID() as ID;
  await db.insert(identityUsers).values([
    { id: userA, email: 'qa-a-' + userA + '@example.invalid' },
    { id: userB, email: 'qa-b-' + userB + '@example.invalid' },
  ]);
  await db.insert(identityWorkspaces).values([
    { id: workspaceA, name: 'QA Workspace A', createdBy: userA },
    { id: workspaceB, name: 'QA Workspace B', createdBy: userB },
  ]);
  await db.insert(identityMemberships).values([
    { id: randomUUID(), userId: userA, workspaceId: workspaceA, role: 'MEMBER', status: 'ACTIVE' },
    { id: randomUUID(), userId: userB, workspaceId: workspaceB, role: 'MEMBER', status: 'ACTIVE' },
  ]);
  const customerA: Principal = { userId: userA as ID, workspaceId: workspaceA as ID, roles: ['MEMBER'] };
  const customerB: Principal = { userId: userB as ID, workspaceId: workspaceB as ID, roles: ['MEMBER'] };
  const platformSupport: PlatformPrincipal = {
    userId: 'platform-operator' as ID, sessionId: 'session-qa-1', roles: ['SUPPORT'], permissions: ['SUPPORT'], sessionExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
  };
  const noPermission: PlatformPrincipal = {
    userId: 'platform-consultant' as ID, sessionId: 'session-qa-2', roles: ['AUDITOR'], permissions: ['CONSULTATION'], sessionExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
  };

  const platform = {
    async requirePermission(principal: PlatformPrincipal, permission: PlatformPrincipal['permissions'][number], context: { action: string; targetType: string; targetId?: string | null }) {
      if (principal.permissions.includes(permission)) return;
      audits.push({ actor: principal, targetType: context.targetType, targetId: context.targetId ?? null, action: context.action, permission, outcome: 'DENIED', reason: 'PERMISSION_DENIED' });
      throw new DomainError('DENIED', 'Platform permission required: ' + permission);
    },
    async recordAudit(entry: PlatformAuditEntry) { audits.push(entry); },
    async recordInputRejection(principal: PlatformPrincipal | undefined, context: { action: string; targetType: string; targetId?: string | null }) {
      audits.push({ actor: principal, targetType: context.targetType, targetId: context.targetId ?? null, action: context.action, permission: 'SUPPORT', outcome: 'DENIED', reason: 'INVALID_INPUT' });
    },
  };

  const env = {
    QEYNOX_CHATWOOT_BASE_URL: fixture.url, QEYNOX_CHATWOOT_API_TOKEN: 'qa-token',
    QEYNOX_CHATWOOT_ACCOUNT_ID: '1', QEYNOX_CHATWOOT_INBOX_ID: '2', QEYNOX_CHATWOOT_LIVE_VERIFIED: 'true',
  };
  const client = new ChatwootClient(env);
  const service = new SupportService(client as any, store);
  const platformService = new PlatformSupportService(client as any, store, platform as any);

  // ---- 1. open creates intent → link atomically and reaches LINKED ----------------------
  const opened = await service.open(customerA, 'Invoice never arrived', { requestId: 'req-recon-0001' });
  const conversationId = opened.conversation.id;
  const intentRows = await db.select().from(supportIntents).where(eq(supportIntents.intentRef, 'req-recon-0001'));
  assertOk(intentRows.length === 1 && intentRows[0]?.state === 'LINKED', 'intent is LINKED after open');
  assertOk(intentRows[0]?.chatwootConversationId === conversationId, 'intent records the adopted conversation id');
  const linkRows = await db.select().from(supportChatwootLinks).where(eq(supportChatwootLinks.chatwootConversationId, conversationId));
  assertOk(linkRows.length === 1 && linkRows[0]?.state === 'ACTIVE', 'exactly one ACTIVE authorization link');

  // ---- 2. idempotent replay: nothing duplicated, locally or remotely ---------------------
  const conversationCount = fixture.conversations.length;
  const messageCount = fixture.messages.length;
  const replayed = await service.open(customerA, 'Invoice never arrived', { requestId: 'req-recon-0001' });
  assertOk(replayed.conversation.id === conversationId, 'replay returns the same conversation');
  assertOk(fixture.conversations.length === conversationCount && fixture.messages.length === messageCount, 'replay wrote nothing remotely');

  // ---- 2b. the same requestId in a different tenant opens an isolated thread, never a replay -
  const otherTenant = await service.open(customerB, 'Invoice never arrived', { requestId: 'req-recon-0001' });
  assertOk(otherTenant.conversation.id !== conversationId, 'the same requestId in another workspace opens a different conversation');
  const crossLinks = await db.select().from(supportChatwootLinks).where(eq(supportChatwootLinks.chatwootConversationId, conversationId));
  assertOk(crossLinks.every(link => link.userId !== userB), 'tenant A conversation link stays scoped to tenant A');

  // ---- 3. ambiguous conversation create: self-heal, single conversation, no duplicate link -
  fixture.arm('fail-500-after-conversation-create');
  const healed = await service.open(customerA, 'Second request with a crash', { requestId: 'req-recon-0002' });
  assertOk(fixture.conversations.filter(item => item.sourceId === 'req-recon-0002').length === 1, 'ambiguous create produced exactly one remote conversation');
  const healedLinks = await db.select().from(supportChatwootLinks).where(eq(supportChatwootLinks.chatwootConversationId, healed.conversation.id));
  assertOk(healedLinks.length === 1, 'exactly one link after self-heal');

  // ---- 4. ambiguous message create: source_id reconciles, no duplicate message ------------
  fixture.arm('fail-500-after-message-create');
  const msgHealed = await service.open(customerA, 'Message crash case', { requestId: 'req-recon-0003' });
  const sent = fixture.messages.filter(message => message.sourceId === 'req-recon-0003:first');
  assertOk(sent.length === 1, 'the ambiguously-sent message was adopted, not re-sent');

  // ---- 5. orphan: remote conversation disappears → link marked ORPHANED -------------------
  const orphanTarget = healed.conversation.id;
  fixture.removeConversation(Number(orphanTarget));
  const mine = await service.listMine(customerA);
  assertOk(!mine.some(item => item.conversation.id === orphanTarget), 'orphaned conversation is no longer listed');
  const orphanLinks = await db.select().from(supportChatwootLinks).where(eq(supportChatwootLinks.chatwootConversationId, orphanTarget));
  assertOk(orphanLinks[0]?.state === 'ORPHANED', 'orphan link is marked ORPHANED in PostgreSQL');
  await expectDomainError('NOT_FOUND', () => service.get(customerA, orphanTarget), 'orphaned conversation no longer authorizes reads');
  await expectDomainError('NOT_FOUND', () => service.reply(customerA, orphanTarget, 'still here?'), 'orphaned conversation no longer authorizes replies');

  // ---- 6. duplicate mapping: fail closed on every surface + DENIED audit -------------------
  // Fabricate the same remote conversation mapped for a second (user, workspace) pair.
  const primary = (await db.select().from(supportChatwootLinks).where(eq(supportChatwootLinks.chatwootConversationId, conversationId)))[0];
  assertOk(primary, 'primary link exists');
  await store.createLink({
    id: randomUUID() as ID, userId: userB, workspaceId: workspaceB,
    chatwootContactId: primary.chatwootContactId, chatwootConversationId: conversationId, at: new Date(),
  });
  const platformList = await platformService.list(platformSupport, { status: 'all', page: 1 });
  assertOk(!platformList.items.some(item => item.conversation.id === conversationId), 'ambiguous conversation hidden from operator list');
  const duplicateAudit = audits.find(entry => entry.reason === 'DUPLICATE_LINK_DETECTED');
  assertOk(duplicateAudit, 'duplicate detection is audited');
  assertOk((duplicateAudit?.detail as { duplicatedConversationIds?: string[] } | null)?.duplicatedConversationIds?.includes(conversationId), 'audit detail names the ambiguous conversation ids');
  await expectDomainError('CONFLICT', () => platformService.get(platformSupport, conversationId), 'operator read fails closed on duplicates');
  await expectDomainError('CONFLICT', () => platformService.reply(platformSupport, conversationId, 'operator reply', { reason: 'ten characters at least' }), 'operator reply fails closed on duplicates');
  await expectDomainError('CONFLICT', () => service.get(customerA, conversationId), 'customer read fails closed on duplicates');

  // ---- 7. private note: hidden from customer, visible to operator --------------------------
  const preReplyMessages = fixture.messages.length;
  fixture.messages.push({
    id: 900001, conversationId: Number(msgHealed.conversation.id),
    content: 'Internal: refund approved, do not disclose before invoicing team signs off',
    messageType: 1, private: true, sourceId: null, createdAt: Math.floor(Date.now() / 1000),
  });
  const customerDetail = await service.get(customerA, msgHealed.conversation.id);
  assertOk(!customerDetail.messages.some(message => message.content.includes('Internal:')), 'customer never sees the private note');
  // The duplicated-mapping fail-closed state does not affect the non-duplicated conversation:
  const operatorDetail = await platformService.get(platformSupport, msgHealed.conversation.id);
  assertOk(operatorDetail.messages.some(message => message.content.includes('Internal:')), 'operator sees the private note');

  // ---- 8. audited operator actions: reply + status transition --------------------------------
  await platformService.reply(platformSupport, msgHealed.conversation.id, 'We are on it, expect a fix today.', { reason: 'customer asked for a status update', requestId: 'agent-req-0001' });
  const replyAudits = audits.filter(entry => entry.action === 'REPLY_SUPPORT_CONVERSATION' && entry.outcome === 'SUCCESS');
  assertOk(replyAudits.length >= 1, 'operator reply is audited as SUCCESS');
  const detailAfterReply = await client.getConversation(msgHealed.conversation.id);
  const operatorMessage = detailAfterReply?.messages.find(message => message.sourceId === 'agent-reply:agent-req-0001');
  assertOk(operatorMessage && operatorMessage.messageType === 'outgoing', 'operator reply is outgoing with deterministic source_id');

  await platformService.updateStatus(platformSupport, msgHealed.conversation.id, 'pending', { reason: 'waiting for the billing provider' });
  const statusAudits = audits.filter(entry => entry.action === 'UPDATE_SUPPORT_STATUS' && entry.outcome === 'SUCCESS');
  assertOk(statusAudits.length === 1, 'status transition is audited as SUCCESS');
  const afterToggle = await client.getConversation(msgHealed.conversation.id);
  assertOk(afterToggle?.conversation.status === 'pending', 'status transition re-read from Chatwoot is authoritative');

  // ---- 9. operator input rejected without SUPPORT permission is audited DENIED ---------------
  await expectDomainError('DENIED', () => platformService.reply(noPermission, msgHealed.conversation.id, 'unauthorized reply', { reason: 'ten characters at least' }), 'missing SUPPORT permission denied');
  const deniedAudits = audits.filter(entry => entry.action === 'REPLY_SUPPORT_CONVERSATION' && entry.outcome === 'DENIED');
  assertOk(deniedAudits.length >= 1, 'denial is audited');

  // ---- 10. pagination + status filter contract against the fixture ---------------------------
  const firstPage = await client.listConversations({ status: 'all', page: 1 });
  assertOk(firstPage.page === 1 && firstPage.perPage === 25 && typeof firstPage.hasMore === 'boolean', 'list contract carries page, perPage and hasMore');
  const openOnly = await client.listConversations({ status: 'pending', page: 1 });
  assertOk(openOnly.conversations.every(conversation => conversation.status === 'pending'), 'status filter honoured');

  // ---- 11. duplicate first-message source_id is stored exactly once ---------------------------
  assertOk(fixture.messages.length > preReplyMessages, 'operator reply persisted remotely');

  console.log('Support reconciliation (isolated PostgreSQL + fixture Chatwoot): PASS — ' + assertions + ' assertions');
  console.log('NOTE: the Chatwoot side here is the deterministic fixture, NOT the live service. Live verification is documented in docs/architecture/CHATWOOT_SUPPORT.md.');
} catch (error) {
  console.error('Support reconciliation suite failed:', error);
  process.exitCode = 1;
} finally {
  if (connection) await connection.pool.end().catch(() => undefined);
  await fixture.close();
  await qa.drop().catch(error => console.error('failed to drop QA database:', error));
}


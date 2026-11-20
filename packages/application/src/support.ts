import {
  DomainError, newId,
  type PlatformPrincipal, type Principal,
  type SupportActorProfile, type SupportCapability, type SupportConversation, type SupportConversationDetail,
  type SupportConversationList, type SupportConversationWithLink, type SupportIntent, type SupportLink, type SupportMessage,
} from '@qeynox/domain';
import { PlatformAdminService, type PlatformPermissionContext } from './platform-admin';

export interface ChatwootContact {
  readonly id: string;
  readonly name: string | null;
  readonly email: string | null;
}

/**
 * Port over the external Chatwoot engine. The adapter talks to the documented Chatwoot REST API;
 * QeyNox never mirrors conversations or messages into its own database.
 *
 * Ambiguity contract: a remote write whose outcome is unknown (timeout, 5xx, lost response) throws
 * DomainError with code UNKNOWN_OUTCOME. Callers must reconcile — via the deterministic `sourceId`
 * stored in support_intents before the remote call — and must never blindly retry.
 */
export interface ChatwootPort {
  readonly capability: SupportCapability;
  createContact(input: {
    readonly email: string; readonly displayName: string;
    readonly userId: string; readonly workspaceId: string;
  }): Promise<ChatwootContact>;
  findContactByIdentifier(identifier: string): Promise<ChatwootContact | null>;
  createConversation(input: { readonly contactId: string; readonly sourceId: string }): Promise<SupportConversation>;
  findConversationsBySourceId(sourceId: string): Promise<readonly SupportConversation[]>;
  getConversation(chatwootConversationId: string): Promise<SupportConversationDetail | null>;
  listConversations(input: { readonly status?: string | undefined; readonly page?: number | undefined }): Promise<SupportConversationList>;
  sendMessage(chatwootConversationId: string, content: string, direction: 'incoming' | 'outgoing', sourceId?: string): Promise<SupportMessage>;
  updateStatus(chatwootConversationId: string, status: 'open' | 'pending' | 'resolved'): Promise<void>;
}

export interface SupportLinkRepository {
  findContact(userId: string, workspaceId: string): Promise<SupportLink | undefined>;
  findConversation(userId: string, workspaceId: string, chatwootConversationId: string): Promise<SupportLink | undefined>;
  listForUser(userId: string, workspaceId: string): Promise<readonly SupportLink[]>;
  listForConversations(conversationIds: readonly string[]): Promise<readonly SupportLink[]>;
  findDuplicatedConversationIds(conversationIds: readonly string[]): Promise<ReadonlySet<string>>;
  createIntent(input: {
    readonly id: string; readonly userId: string; readonly workspaceId: string; readonly intentRef: string; readonly at: Date;
  }): Promise<{ readonly created: boolean; readonly intent: SupportIntent }>;
  /** Tenant-scoped lookup; an intent_ref is never resolved across tenants. */
  findIntentByRef(userId: string, workspaceId: string, intentRef: string): Promise<SupportIntent | undefined>;
  updateIntent(id: string, input: {
    readonly state: 'PENDING_CONTACT' | 'PENDING_CONVERSATION' | 'LINKED' | 'FAILED' | 'ORPHANED';
    readonly chatwootContactId?: string | null;
    readonly chatwootConversationId?: string | null;
    readonly failureCode?: string | null;
    readonly at: Date;
  }): Promise<void>;
  createLink(input: {
    readonly id: string; readonly userId: string; readonly workspaceId: string;
    readonly chatwootContactId: string; readonly chatwootConversationId: string; readonly at: Date;
    readonly intentId?: string | undefined;
  }): Promise<SupportLink>;
  markOrphaned(linkId: string, at: Date): Promise<void>;
  touch(linkId: string, at: Date): Promise<void>;
  actorProfile(userId: string, workspaceId: string): Promise<SupportActorProfile | undefined>;
}

function requireCapability(port: ChatwootPort): void {
  if (port.capability.status !== 'CONFIGURED') {
    throw new DomainError('NOT_CONFIGURED', 'Chatwoot support is not configured: ' + (port.capability.reason ?? 'CHATWOOT_NOT_CONFIGURED'));
  }
}

function requireContent(value: string): string {
  const content = value.trim();
  if (content.length < 2 || content.length > 5000) throw new DomainError('INVALID_INPUT', 'Support message must be 2–5000 characters');
  return content;
}

/** A customer may only ever see explicitly public, customer-visible message types. */
function isCustomerVisibleMessage(message: SupportMessage): boolean {
  return message.private === false && (message.messageType === 'incoming' || message.messageType === 'outgoing');
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
const contactIdentifier = (userId: string, workspaceId: string): string => 'qeynox:' + userId + ':' + workspaceId;

/** Lowest numeric Chatwoot display id — the deterministic pick when duplicates are found. */
function earliest(conversations: readonly SupportConversation[]): SupportConversation {
  return [...conversations].sort((a, b) => Number(a.id) - Number(b.id))[0] as SupportConversation;
}

/**
 * Customer-facing support service. A user can only list, read and reply to conversations that are
 * explicitly mapped to their own identity and active workspace; no arbitrary Chatwoot id is accepted.
 */
export class SupportService {
  constructor(
    private readonly port: ChatwootPort,
    private readonly links: SupportLinkRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  capability(): SupportCapability { return this.port.capability; }

  async listMine(actor: Principal): Promise<readonly SupportConversationWithLink[]> {
    requireCapability(this.port);
    const links = await this.links.listForUser(actor.userId, actor.workspaceId);
    const active = links.filter(link => link.state === 'ACTIVE');
    const duplicated = await this.links.findDuplicatedConversationIds(active.map(link => link.chatwootConversationId));
    const result: SupportConversationWithLink[] = [];
    for (const link of active) {
      if (duplicated.has(link.chatwootConversationId)) continue; // ambiguous mapping: fail closed, see platform surface
      const detail = await this.port.getConversation(link.chatwootConversationId);
      if (detail === null) {
        await this.links.markOrphaned(link.id, this.now());
        continue;
      }
      result.push({ conversation: detail.conversation, qeynox: { userId: actor.userId, workspaceId: actor.workspaceId } });
    }
    return result;
  }

  async open(actor: Principal, message: string, options?: { readonly requestId?: string | undefined }): Promise<SupportConversationDetail> {
    requireCapability(this.port);
    const content = requireContent(message);
    const profile = await this.links.actorProfile(actor.userId, actor.workspaceId);
    if (!profile) throw new DomainError('DENIED', 'Active workspace membership required');
    const now = this.now();

    // 1. Durable intent BEFORE any remote write; the deterministic source_id survives ambiguous outcomes.
    const intentRef = (options?.requestId ?? newId()).trim();
    const { created, intent: initialIntent } = await this.links.createIntent({
      id: newId(), userId: actor.userId, workspaceId: actor.workspaceId, intentRef, at: now,
    });

    // Idempotent replay: the same requestId was already fully linked — hand back that conversation.
    if (!created && initialIntent.state === 'LINKED' && initialIntent.chatwootConversationId) {
      return this.replayLinked(actor, initialIntent.chatwootConversationId);
    }

    let intent = initialIntent;
    if (!created && intent.state !== 'FAILED') {
      // A twin request with the same idempotency key is in flight: give it a bounded head start
      // instead of racing the remote for the same conversation, then reconcile either way.
      const deadline = Date.now() + 1500;
      while (intent.state !== 'LINKED' && intent.state !== 'FAILED' && Date.now() < deadline) {
        await sleep(100);
        const reread = await this.links.findIntentByRef(actor.userId, actor.workspaceId, intentRef);
        if (!reread) break;
        intent = reread;
      }
      if (intent.state === 'LINKED' && intent.chatwootConversationId) {
        return this.replayLinked(actor, intent.chatwootConversationId);
      }
    }

    // 2. Contact resolution with reconciliation.
    const contactId = await this.resolveContact(actor, profile, intent.chatwootContactId, intent.id, now);

    // 3. Conversation resolution with reconciliation (adopt before creating).
    const conversation = await this.resolveConversation(intent.id, contactId, intentRef);
    const conversationId = conversation.id;

    // 4. Authorization mapping + LINKED transition in one transaction.
    if (intent.state !== 'LINKED') {
      await this.links.createLink({
        id: newId(), userId: actor.userId, workspaceId: actor.workspaceId,
        chatwootContactId: contactId, chatwootConversationId: conversationId, at: this.now(),
        intentId: intent.id,
      });
    }

    // 5. First message, idempotent by source_id when the outcome was ambiguous.
    const firstMessageSourceId = intentRef + ':first';
    const first = await this.sendFirstMessage(conversationId, content, firstMessageSourceId, intent.id);

    const detail = await this.port.getConversation(conversationId);
    const messages = detail
      ? [...detail.messages].filter(isCustomerVisibleMessage)
      : [first];
    return { conversation: detail?.conversation ?? conversation, messages: detail ? messages : [first] };
  }

  private async replayLinked(actor: Principal, conversationId: string): Promise<SupportConversationDetail> {
    const link = await this.links.findConversation(actor.userId, actor.workspaceId, conversationId);
    if (!link || link.state !== 'ACTIVE') throw new DomainError('NOT_FOUND', 'Support conversation not found');
    const detail = await this.port.getConversation(conversationId);
    if (!detail) throw new DomainError('NOT_FOUND', 'Support conversation not found');
    return { conversation: detail.conversation, messages: detail.messages.filter(isCustomerVisibleMessage) };
  }

  private async resolveContact(
    actor: Principal,
    profile: SupportActorProfile,
    intentContactId: string | null,
    intentId: string,
    now: Date,
  ): Promise<string> {
    if (intentContactId) return intentContactId;
    const existingLink = await this.links.findContact(actor.userId, actor.workspaceId);
    if (existingLink && existingLink.state === 'ACTIVE') {
      await this.links.updateIntent(intentId, { state: 'PENDING_CONVERSATION', chatwootContactId: existingLink.chatwootContactId, at: now });
      return existingLink.chatwootContactId;
    }
    const identifier = contactIdentifier(actor.userId, actor.workspaceId);
    try {
      const found = await this.port.findContactByIdentifier(identifier);
      if (found) {
        await this.links.updateIntent(intentId, { state: 'PENDING_CONVERSATION', chatwootContactId: found.id, at: this.now() });
        return found.id;
      }
      const created = await this.port.createContact({
        email: profile.email, displayName: profile.displayName, userId: actor.userId, workspaceId: actor.workspaceId,
      });
      await this.links.updateIntent(intentId, { state: 'PENDING_CONVERSATION', chatwootContactId: created.id, at: this.now() });
      return created.id;
    } catch (error: unknown) {
      if (error instanceof DomainError && error.code === 'UNKNOWN_OUTCOME') {
        // Ambiguous: the create may have landed. Reconcile by identifier exactly once.
        const found = await this.port.findContactByIdentifier(identifier).catch(() => null);
        if (found) {
          await this.links.updateIntent(intentId, { state: 'PENDING_CONVERSATION', chatwootContactId: found.id, at: this.now() });
          return found.id;
        }
        await this.links.updateIntent(intentId, { state: 'FAILED', failureCode: 'CONTACT_AMBIGUOUS', at: this.now() });
      }
      throw error;
    }
  }

  private async resolveConversation(
    intentId: string,
    contactId: string,
    intentRef: string,
  ): Promise<SupportConversation> {
    // Adopt a conversation created by an earlier, ambiguous attempt BEFORE creating a new one.
    // Candidates must belong to THIS tenant's contact: source_id is only scoped to the inbox account
    // remotely, so a matching source_id without the matching contact is another tenant's thread.
    const adopt = async (): Promise<SupportConversation | null> => {
      const found = (await this.port.findConversationsBySourceId(intentRef))
        .filter(conversation => conversation.contact.id === contactId);
      if (found.length === 0) return null;
      const adopted = earliest(found);
      if (found.length > 1) {
        // Duplicate conversations detected: adopt the earliest deterministically and record the anomaly.
        await this.links.updateIntent(intentId, { state: 'PENDING_CONVERSATION', chatwootConversationId: adopted.id, chatwootContactId: contactId, failureCode: 'DUPLICATE_CONVERSATIONS_DETECTED', at: this.now() });
        return adopted;
      }
      await this.links.updateIntent(intentId, { state: 'PENDING_CONVERSATION', chatwootConversationId: adopted.id, chatwootContactId: contactId, failureCode: null, at: this.now() });
      return adopted;
    };
    const existing = await adopt();
    if (existing) return existing;
    try {
      const created = await this.port.createConversation({ contactId, sourceId: intentRef });
      await this.links.updateIntent(intentId, { state: 'PENDING_CONVERSATION', chatwootConversationId: created.id, chatwootContactId: contactId, at: this.now() });
      return created;
    } catch (error: unknown) {
      if (error instanceof DomainError && error.code === 'UNKNOWN_OUTCOME') {
        const found = await adopt().catch(() => null);
        if (found) return found;
        await this.links.updateIntent(intentId, { state: 'FAILED', failureCode: 'CONVERSATION_AMBIGUOUS', at: this.now() });
      }
      throw error;
    }
  }

  private async sendFirstMessage(conversationId: string, content: string, sourceId: string, intentId: string): Promise<SupportMessage> {
    // Re-check history first: a twin request whose wait expired converges here instead of double-sending.
    const beforeSend = await this.port.getConversation(conversationId).catch(() => null);
    const alreadySent = beforeSend?.messages.find(message => message.sourceId === sourceId);
    if (alreadySent) return alreadySent;
    try {
      return await this.port.sendMessage(conversationId, content, 'incoming', sourceId);
    } catch (error: unknown) {
      if (error instanceof DomainError && error.code === 'UNKNOWN_OUTCOME') {
        const detail = await this.port.getConversation(conversationId).catch(() => null);
        const delivered = detail?.messages.find(message => message.sourceId === sourceId && message.messageType === 'incoming');
        if (delivered) return delivered;
        // One bounded retry with the same source_id: at most one message can carry it.
        try {
          return await this.port.sendMessage(conversationId, content, 'incoming', sourceId);
        } catch (retryError: unknown) {
          if (retryError instanceof DomainError && retryError.code === 'UNKNOWN_OUTCOME') {
            const confirmed = await this.port.getConversation(conversationId).catch(() => null);
            if (confirmed?.messages.some(message => message.sourceId === sourceId)) {
              return confirmed.messages.find(message => message.sourceId === sourceId) as SupportMessage;
            }
          }
          await this.links.updateIntent(intentId, { state: 'FAILED', failureCode: 'MESSAGE_AMBIGUOUS', at: this.now() });
          throw new DomainError('UNKNOWN_OUTCOME', 'The first support message outcome is unknown; the conversation was kept and linked. Check before resending.');
        }
      }
      throw error;
    }
  }

  async get(actor: Principal, chatwootConversationId: string): Promise<SupportConversationDetail> {
    requireCapability(this.port);
    const link = await this.links.findConversation(actor.userId, actor.workspaceId, chatwootConversationId);
    if (!link || link.state !== 'ACTIVE') throw new DomainError('NOT_FOUND', 'Support conversation not found');
    const duplicated = await this.links.findDuplicatedConversationIds([chatwootConversationId]);
    if (duplicated.has(chatwootConversationId)) {
      throw new DomainError('CONFLICT', 'Support conversation mapping is ambiguous; blocked pending review');
    }
    const detail = await this.port.getConversation(chatwootConversationId);
    if (!detail) {
      await this.links.markOrphaned(link.id, this.now());
      throw new DomainError('NOT_FOUND', 'Support conversation not found');
    }
    return { ...detail, messages: detail.messages.filter(isCustomerVisibleMessage) };
  }

  async reply(actor: Principal, chatwootConversationId: string, content: string, options?: { readonly requestId?: string | undefined }): Promise<SupportConversationDetail> {
    requireCapability(this.port);
    const link = await this.links.findConversation(actor.userId, actor.workspaceId, chatwootConversationId);
    if (!link || link.state !== 'ACTIVE') throw new DomainError('NOT_FOUND', 'Support conversation not found');
    const duplicated = await this.links.findDuplicatedConversationIds([chatwootConversationId]);
    if (duplicated.has(chatwootConversationId)) {
      throw new DomainError('CONFLICT', 'Support conversation mapping is ambiguous; blocked pending review');
    }
    const requestId = options?.requestId?.trim();
    const sourceId = requestId ? 'reply:' + requestId : undefined;
    if (sourceId) {
      const detail = await this.port.getConversation(chatwootConversationId);
      const already = detail?.messages.find(message => message.sourceId === sourceId);
      if (already) {
        await this.links.touch(link.id, this.now());
        return this.get(actor, chatwootConversationId);
      }
    }
    try {
      await this.port.sendMessage(chatwootConversationId, requireContent(content), 'incoming', sourceId);
    } catch (error: unknown) {
      if (sourceId && error instanceof DomainError && error.code === 'UNKNOWN_OUTCOME') {
        const confirmed = await this.port.getConversation(chatwootConversationId).catch(() => null);
        if (confirmed?.messages.some(message => message.sourceId === sourceId)) {
          await this.links.touch(link.id, this.now());
          return this.get(actor, chatwootConversationId);
        }
      }
      throw error;
    }
    await this.links.touch(link.id, this.now());
    return this.get(actor, chatwootConversationId);
  }
}

export interface PlatformSupportConversationView {
  readonly conversation: SupportConversation;
  readonly qeynox: Readonly<{ userId: string; workspaceId: string }> | null;
}
export interface PlatformSupportConversationListView {
  readonly items: readonly PlatformSupportConversationView[];
  readonly page: number;
  readonly perPage: number;
  readonly totalCount: number | null;
  readonly hasMore: boolean;
}

export interface PlatformSupportConversationDetailView extends PlatformSupportConversationView {
  readonly messages: readonly SupportMessage[];
}

const operatorReason = (value: string | undefined): string => {
  const trimmed = (value ?? '').trim();
  if (trimmed.length < 10 || trimmed.length > 500) throw new DomainError('INVALID_INPUT', 'A 10–500 character justification is required');
  return trimmed;
};

/**
 * Platform support center. It requires the existing SUPPORT permission and reads the Chatwoot
 * engine live; every reply/status transition is audited. No support message is persisted by QeyNox.
 */
export class PlatformSupportService {
  constructor(
    private readonly port: ChatwootPort,
    private readonly links: SupportLinkRepository,
    private readonly platform: PlatformAdminService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Controller hook: schema-rejected operator input is audited like any other denial. */
  async recordInputRejection(principal: PlatformPrincipal | undefined, context: PlatformPermissionContext): Promise<void> {
    await this.platform.recordInputRejection(principal, context);
  }

  async status(principal: PlatformPrincipal): Promise<{ readonly capability: SupportCapability; readonly note: string }> {
    await this.platform.requirePermission(principal, 'SUPPORT', { action: 'READ_SUPPORT_CENTER', targetType: 'SUPPORT_CENTER' });
    return { capability: this.port.capability, note: 'Chatwoot is the external support engine. QeyNox stores no support message; inbox, status, priority and history are read live.' };
  }

  async list(principal: PlatformPrincipal, input: { readonly status?: string | undefined; readonly page?: number | undefined }): Promise<PlatformSupportConversationListView> {
    await this.platform.requirePermission(principal, 'SUPPORT', { action: 'LIST_SUPPORT_CONVERSATIONS', targetType: 'SUPPORT_CENTER' });
    requireCapability(this.port);
    const result = await this.port.listConversations(input);
    const ids = result.conversations.map(conversation => conversation.id);
    const links = await this.links.listForConversations(ids);
    const duplicated = await this.links.findDuplicatedConversationIds(ids);
    const items: PlatformSupportConversationView[] = [];
    for (const conversation of result.conversations) {
      if (duplicated.has(conversation.id)) continue; // ambiguous mapping: hidden, flagged in the audit trail below
      const linksForConversation = links.filter(item => item.chatwootConversationId === conversation.id);
      if (linksForConversation.length === 0) continue;
      const link = linksForConversation[0] as SupportLink;
      items.push({ conversation, qeynox: { userId: link.userId, workspaceId: link.workspaceId } });
    }
    if (duplicated.size > 0) {
      // Detection is actionable: operators must resolve duplicate mappings in Chatwoot, never silence them.
      await this.platform.recordAudit({
        actor: principal, targetType: 'SUPPORT_CENTER', action: 'LIST_SUPPORT_CONVERSATIONS',
        permission: 'SUPPORT', outcome: 'DENIED', reason: 'DUPLICATE_LINK_DETECTED',
        detail: { duplicatedConversationIds: [...duplicated] },
      });
    }
    return { items, page: result.page, perPage: result.perPage, totalCount: result.totalCount, hasMore: result.hasMore };
  }

  private async requireLinked(id: string): Promise<SupportLink> {
    const links = await this.links.listForConversations([id]);
    const matches = links.filter(item => item.chatwootConversationId === id);
    if (matches.length === 0) throw new DomainError('NOT_FOUND', 'Support conversation not found');
    const duplicated = await this.links.findDuplicatedConversationIds([id]);
    if (duplicated.has(id)) {
      throw new DomainError('CONFLICT', 'Support conversation mapping is ambiguous; blocked pending review');
    }
    const link = matches[0] as SupportLink;
    if (link.state !== 'ACTIVE') throw new DomainError('NOT_FOUND', 'Support conversation not found');
    return link;
  }

  async get(principal: PlatformPrincipal, chatwootConversationId: string): Promise<PlatformSupportConversationDetailView> {
    await this.platform.requirePermission(principal, 'SUPPORT', { action: 'READ_SUPPORT_CONVERSATION', targetType: 'SUPPORT_CONVERSATION', targetId: chatwootConversationId });
    requireCapability(this.port);
    const link = await this.requireLinked(chatwootConversationId);
    const detail = await this.port.getConversation(chatwootConversationId);
    if (!detail) {
      await this.links.markOrphaned(link.id, this.now());
      throw new DomainError('NOT_FOUND', 'Support conversation not found');
    }
    // Platform operators see all messages, including private notes (they are never exposed to the customer surface).
    return { conversation: detail.conversation, messages: detail.messages, qeynox: { userId: link.userId, workspaceId: link.workspaceId } };
  }

  async reply(principal: PlatformPrincipal, chatwootConversationId: string, content: string, input: { readonly reason: string; readonly requestId?: string | undefined }): Promise<PlatformSupportConversationDetailView> {
    const action = 'REPLY_SUPPORT_CONVERSATION';
    await this.platform.requirePermission(principal, 'SUPPORT', { action, targetType: 'SUPPORT_CONVERSATION', targetId: chatwootConversationId });
    requireCapability(this.port);
    const reason = operatorReason(input.reason);
    const link = await this.requireLinked(chatwootConversationId);
    const sourceId = input.requestId?.trim() ? 'agent-reply:' + input.requestId.trim() : undefined;
    if (sourceId) {
      const before = await this.port.getConversation(chatwootConversationId);
      const already = before?.messages.find(message => message.sourceId === sourceId);
      if (already) {
        await this.platform.recordAudit({
          actor: principal, targetType: 'SUPPORT_CONVERSATION', targetId: chatwootConversationId,
          action, permission: 'SUPPORT', outcome: 'SUCCESS', reason,
          detail: { justification: reason, requestId: input.requestId, deduplicated: true },
        });
        return this.get(principal, chatwootConversationId);
      }
    }
    try {
      await this.port.sendMessage(chatwootConversationId, requireContent(content), 'outgoing', sourceId);
    } catch (error: unknown) {
      if (sourceId && error instanceof DomainError && error.code === 'UNKNOWN_OUTCOME') {
        const confirmed = await this.port.getConversation(chatwootConversationId).catch(() => null);
        if (confirmed?.messages.some(message => message.sourceId === sourceId)) {
          await this.platform.recordAudit({
            actor: principal, targetType: 'SUPPORT_CONVERSATION', targetId: chatwootConversationId,
            action, permission: 'SUPPORT', outcome: 'SUCCESS', reason,
            detail: { justification: reason, requestId: input.requestId, deduplicated: true },
          });
          return this.get(principal, chatwootConversationId);
        }
      }
      await this.platform.recordAudit({
        actor: principal, targetType: 'SUPPORT_CONVERSATION', targetId: chatwootConversationId,
        action, permission: 'SUPPORT', outcome: 'ERROR', reason: error instanceof DomainError ? error.code : 'UNKNOWN',
        detail: { justification: reason, requestId: input.requestId ?? null },
      });
      throw error;
    }
    await this.links.touch(link.id, this.now());
    await this.platform.recordAudit({
      actor: principal, targetType: 'SUPPORT_CONVERSATION', targetId: chatwootConversationId,
      action, permission: 'SUPPORT', outcome: 'SUCCESS', reason,
      detail: { justification: reason, requestId: input.requestId ?? null },
    });
    return this.get(principal, chatwootConversationId);
  }

  async updateStatus(principal: PlatformPrincipal, chatwootConversationId: string, status: 'open' | 'pending' | 'resolved', input: { readonly reason: string }): Promise<PlatformSupportConversationDetailView> {
    const action = 'UPDATE_SUPPORT_STATUS';
    await this.platform.requirePermission(principal, 'SUPPORT', { action, targetType: 'SUPPORT_CONVERSATION', targetId: chatwootConversationId });
    requireCapability(this.port);
    const reason = operatorReason(input.reason);
    await this.requireLinked(chatwootConversationId);
    try {
      await this.port.updateStatus(chatwootConversationId, status);
    } catch (error: unknown) {
      await this.platform.recordAudit({
        actor: principal, targetType: 'SUPPORT_CONVERSATION', targetId: chatwootConversationId,
        action, permission: 'SUPPORT', outcome: 'ERROR', reason: error instanceof DomainError ? error.code : 'UNKNOWN',
        detail: { requestedStatus: status, justification: reason },
      });
      throw error;
    }
    await this.platform.recordAudit({
      actor: principal, targetType: 'SUPPORT_CONVERSATION', targetId: chatwootConversationId,
      action, permission: 'SUPPORT', outcome: 'SUCCESS', reason,
      detail: { requestedStatus: status, justification: reason },
    });
    // Re-read for the authoritative state instead of trusting the toggle response body.
    return this.get(principal, chatwootConversationId);
  }
}

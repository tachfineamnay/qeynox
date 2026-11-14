import {
  DomainError, newId,
  type PlatformPrincipal, type Principal,
  type SupportActorProfile, type SupportCapability, type SupportConversation, type SupportConversationDetail,
  type SupportConversationWithLink, type SupportLink, type SupportMessage,
} from '@qeynox/domain';
import { PlatformAdminService } from './platform-admin';

export interface ChatwootContact {
  readonly id: string;
  readonly name: string | null;
  readonly email: string | null;
}

/**
 * Port over the external Chatwoot engine. The adapter talks to the documented Chatwoot REST API;
 * QeyNox never mirrors conversations or messages into its own database.
 */
export interface ChatwootPort {
  readonly capability: SupportCapability;
  createContact(input: {
    readonly email: string; readonly displayName: string;
    readonly userId: string; readonly workspaceId: string;
  }): Promise<ChatwootContact>;
  createConversation(input: { readonly contactId: string }): Promise<SupportConversation>;
  getConversation(chatwootConversationId: string): Promise<SupportConversationDetail | null>;
  listConversations(input: { readonly status?: string | undefined }): Promise<readonly SupportConversation[]>;
  sendMessage(chatwootConversationId: string, content: string, direction: 'incoming' | 'outgoing'): Promise<SupportMessage>;
  updateStatus(chatwootConversationId: string, status: 'open' | 'pending' | 'resolved'): Promise<SupportConversation>;
}

export interface SupportLinkRepository {
  findContact(userId: string, workspaceId: string): Promise<SupportLink | undefined>;
  findConversation(userId: string, workspaceId: string, chatwootConversationId: string): Promise<SupportLink | undefined>;
  listForUser(userId: string, workspaceId: string): Promise<readonly SupportLink[]>;
  listForConversations(conversationIds: readonly string[]): Promise<readonly SupportLink[]>;
  createLink(input: {
    readonly id: string; readonly userId: string; readonly workspaceId: string;
    readonly chatwootContactId: string; readonly chatwootConversationId: string; readonly at: Date;
  }): Promise<SupportLink>;
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
    const result: SupportConversationWithLink[] = [];
    for (const link of links) {
      const detail = await this.port.getConversation(link.chatwootConversationId);
      if (detail === null) continue;
      result.push({ conversation: detail.conversation, qeynox: { userId: actor.userId, workspaceId: actor.workspaceId } });
    }
    return result;
  }

  async open(actor: Principal, message: string): Promise<SupportConversationDetail> {
    requireCapability(this.port);
    const content = requireContent(message);
    const profile = await this.links.actorProfile(actor.userId, actor.workspaceId);
    if (!profile) throw new DomainError('DENIED', 'Active workspace membership required');
    const existing = await this.links.findContact(actor.userId, actor.workspaceId);
    const contact = existing === undefined
      ? await this.port.createContact({ email: profile.email, displayName: profile.displayName, userId: actor.userId, workspaceId: actor.workspaceId })
      : { id: existing.chatwootContactId, name: profile.displayName, email: profile.email };
    const conversation = await this.port.createConversation({ contactId: contact.id });
    await this.links.createLink({
      id: newId(), userId: actor.userId, workspaceId: actor.workspaceId,
      chatwootContactId: contact.id, chatwootConversationId: conversation.id, at: this.now(),
    });
    const first = await this.port.sendMessage(conversation.id, content, 'incoming');
    return { conversation, messages: [first] };
  }

  async get(actor: Principal, chatwootConversationId: string): Promise<SupportConversationDetail> {
    requireCapability(this.port);
    const link = await this.links.findConversation(actor.userId, actor.workspaceId, chatwootConversationId);
    if (!link) throw new DomainError('NOT_FOUND', 'Support conversation not found');
    const detail = await this.port.getConversation(chatwootConversationId);
    if (!detail) throw new DomainError('NOT_FOUND', 'Support conversation not found');
    return { ...detail, messages: detail.messages.filter(message => message.private === false) };
  }

  async reply(actor: Principal, chatwootConversationId: string, content: string): Promise<SupportConversationDetail> {
    requireCapability(this.port);
    const link = await this.links.findConversation(actor.userId, actor.workspaceId, chatwootConversationId);
    if (!link) throw new DomainError('NOT_FOUND', 'Support conversation not found');
    await this.port.sendMessage(chatwootConversationId, requireContent(content), 'incoming');
    await this.links.touch(link.id, this.now());
    return this.get(actor, chatwootConversationId);
  }
}

export interface PlatformSupportConversationView {
  readonly conversation: SupportConversation;
  readonly qeynox: Readonly<{ userId: string; workspaceId: string }> | null;
}

export interface PlatformSupportConversationDetailView extends PlatformSupportConversationView {
  readonly messages: readonly SupportMessage[];
}

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

  async status(principal: PlatformPrincipal): Promise<{ readonly capability: SupportCapability; readonly note: string }> {
    await this.platform.requirePermission(principal, 'SUPPORT', { action: 'READ_SUPPORT_CENTER', targetType: 'SUPPORT_CENTER' });
    return { capability: this.port.capability, note: 'Chatwoot is the external support engine. QeyNox stores no support message; inbox, status, priority and history are read live.' };
  }

  async list(principal: PlatformPrincipal, input: { readonly status?: string | undefined }): Promise<readonly PlatformSupportConversationView[]> {
    await this.platform.requirePermission(principal, 'SUPPORT', { action: 'LIST_SUPPORT_CONVERSATIONS', targetType: 'SUPPORT_CENTER' });
    requireCapability(this.port);
    const conversations = await this.port.listConversations(input);
    const links = await this.links.listForConversations(conversations.map(conversation => conversation.id));
    return conversations.flatMap(conversation => {
      const link = links.find(item => item.chatwootConversationId === conversation.id);
      return link ? [{ conversation, qeynox: { userId: link.userId, workspaceId: link.workspaceId } }] : [];
    });
  }

  private async requireLinked(id: string): Promise<SupportLink> {
    const links = await this.links.listForConversations([id]);
    const link = links.find(item => item.chatwootConversationId === id);
    if (!link) throw new DomainError('NOT_FOUND', 'Support conversation not found');
    return link;
  }

  async get(principal: PlatformPrincipal, chatwootConversationId: string): Promise<PlatformSupportConversationDetailView> {
    await this.platform.requirePermission(principal, 'SUPPORT', { action: 'READ_SUPPORT_CONVERSATION', targetType: 'SUPPORT_CONVERSATION', targetId: chatwootConversationId });
    requireCapability(this.port);
    const link = await this.requireLinked(chatwootConversationId);
    const detail = await this.port.getConversation(chatwootConversationId);
    if (!detail) throw new DomainError('NOT_FOUND', 'Support conversation not found');
    return { conversation: detail.conversation, messages: detail.messages, qeynox: { userId: link.userId, workspaceId: link.workspaceId } };
  }

  async reply(principal: PlatformPrincipal, chatwootConversationId: string, content: string): Promise<PlatformSupportConversationDetailView> {
    await this.platform.requirePermission(principal, 'SUPPORT', { action: 'REPLY_SUPPORT_CONVERSATION', targetType: 'SUPPORT_CONVERSATION', targetId: chatwootConversationId });
    requireCapability(this.port);
    await this.requireLinked(chatwootConversationId);
    await this.port.sendMessage(chatwootConversationId, requireContent(content), 'outgoing');
    await this.platform.recordAudit({
      actor: principal, targetType: 'SUPPORT_CONVERSATION', targetId: chatwootConversationId,
      action: 'REPLY_SUPPORT_CONVERSATION', permission: 'SUPPORT', outcome: 'SUCCESS',
    });
    return this.get(principal, chatwootConversationId);
  }

  async updateStatus(principal: PlatformPrincipal, chatwootConversationId: string, status: 'open' | 'pending' | 'resolved'): Promise<PlatformSupportConversationDetailView> {
    await this.platform.requirePermission(principal, 'SUPPORT', { action: 'UPDATE_SUPPORT_STATUS', targetType: 'SUPPORT_CONVERSATION', targetId: chatwootConversationId });
    requireCapability(this.port);
    await this.requireLinked(chatwootConversationId);
    await this.port.updateStatus(chatwootConversationId, status);
    await this.platform.recordAudit({
      actor: principal, targetType: 'SUPPORT_CONVERSATION', targetId: chatwootConversationId,
      action: 'UPDATE_SUPPORT_STATUS', permission: 'SUPPORT', outcome: 'SUCCESS', detail: { status },
    });
    return this.get(principal, chatwootConversationId);
  }
}

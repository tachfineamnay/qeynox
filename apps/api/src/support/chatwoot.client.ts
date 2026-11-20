import { randomUUID } from 'node:crypto';
import { DomainError } from '@qeynox/domain';
import type { ChatwootContact, ChatwootPort } from '@qeynox/application';
import type {
  SupportCapability, SupportConversation, SupportConversationDetail, SupportConversationList, SupportMessage,
} from '@qeynox/domain';

interface ChatwootConfig {
  readonly baseUrl: string;
  readonly token: string;
  readonly accountId: string;
  readonly inboxId: string;
}

const configKeys = ['QEYNOX_CHATWOOT_BASE_URL', 'QEYNOX_CHATWOOT_API_TOKEN', 'QEYNOX_CHATWOOT_ACCOUNT_ID', 'QEYNOX_CHATWOOT_INBOX_ID'] as const;

function readConfig(env: NodeJS.ProcessEnv): { readonly config: ChatwootConfig | null; readonly missing: readonly string[] } {
  const values = configKeys.map(key => (env[key] ?? '').trim());
  const missing = configKeys.filter((key, index) => values[index]?.length === 0);
  if (missing.length > 0) return { config: null, missing };
  const baseUrl = (values[0] ?? '').replace(/\/+$/, '');
  let url: URL;
  try { url = new URL(baseUrl); } catch { return { config: null, missing: ['QEYNOX_CHATWOOT_BASE_URL_INVALID'] }; }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && loopback))) return { config: null, missing: ['QEYNOX_CHATWOOT_BASE_URL_INSECURE'] };
  if (url.username || url.password || url.search || url.hash) return { config: null, missing: ['QEYNOX_CHATWOOT_BASE_URL_INVALID'] };
  if (!/^\d+$/.test(values[2] ?? '') || !/^\d+$/.test(values[3] ?? '')) return { config: null, missing: ['QEYNOX_CHATWOOT_ACCOUNT_OR_INBOX_INVALID'] };
  return { config: { baseUrl, token: values[1] ?? '', accountId: values[2] ?? '', inboxId: values[3] ?? '' }, missing: [] };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function asArray(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function asText(value: unknown): string | null {
  if (typeof value === 'string') return value.length ? value : null;
  if (typeof value === 'number') return String(value);
  return null;
}
function asNumber(value: unknown): number | null { const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN; return Number.isFinite(n) ? n : null; }
function asIso(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') { const date = new Date(value > 1_000_000_000_000 ? value : value * 1000); return Number.isNaN(date.getTime()) ? null : date.toISOString(); }
  return null;
}
function payloadOf(body: unknown): unknown {
  const root = asRecord(body);
  const data = asRecord(root.data);
  return data.payload ?? root.payload ?? (root.data ?? body);
}
function metaOf(body: unknown): Record<string, unknown> {
  const root = asRecord(body);
  return asRecord(asRecord(root.data).meta ?? root.meta);
}
const messageTypes: readonly string[] = ['incoming', 'outgoing', 'activity', 'template'];
function normalizeMessage(raw: unknown): SupportMessage {
  const value = asRecord(raw);
  const sender = asRecord(value.sender);
  const rawType = value.message_type;
  const messageType = typeof rawType === 'number'
    ? (messageTypes[rawType] ?? 'unknown')
    : (asText(rawType) ?? 'unknown');
  return {
    id: asText(value.id) ?? randomUUID(),
    content: asText(value.content) ?? '',
    messageType,
    // Unknown visibility is treated as private: a note whose visibility cannot be proven is never shown to a customer.
    private: value.private !== false,
    sourceId: asText(value.source_id),
    createdAt: asIso(value.created_at) ?? new Date(0).toISOString(),
    sender: { id: asText(sender.id), name: asText(sender.name), type: asText(sender.type) },
  };
}
function normalizeConversation(raw: unknown): SupportConversation {
  const value = asRecord(raw);
  const meta = asRecord(value.meta);
  const contact = asRecord(meta.sender);
  const assigneeRaw = asRecord(meta.assignee);
  const lastMessage = asArray(value.messages).at(-1);
  return {
    id: asText(value.id) ?? 'unknown',
    status: asText(value.status) ?? 'unknown',
    priority: asText(value.priority),
    inboxId: asText(value.inbox_id),
    createdAt: asIso(value.created_at),
    updatedAt: asIso(value.updated_at),
    lastMessageAt: asIso(value.last_activity_at) ?? asIso(asRecord(lastMessage).created_at),
    contact: { id: asText(contact.id), name: asText(contact.name), email: asText(contact.email) },
    assignee: Object.keys(assigneeRaw).length ? { id: asText(assigneeRaw.id), name: asText(assigneeRaw.name) } : null,
  };
}

export const CHATWOOT_LIVE_VERIFICATION_VAR = 'QEYNOX_CHATWOOT_LIVE_VERIFIED';

/**
 * Chatwoot REST adapter (server-only; the API token never reaches a browser).
 *
 * Endpoints used, matching the Chatwoot API (verified against the Chatwoot source, `develop`):
 * - GET  /api/v1/accounts/{accountId}/conversations                (status, assignee_type, page, source_id filters)
 * - GET  /api/v1/accounts/{accountId}/conversations/{id}
 * - GET  /api/v1/accounts/{accountId}/conversations/{id}/messages
 * - POST /api/v1/accounts/{accountId}/conversations                (inbox_id + contact_id + deterministic source_id)
 * - POST /api/v1/accounts/{accountId}/conversations/{id}/messages  (message_type incoming|outgoing, source_id)
 * - POST /api/v1/accounts/{accountId}/conversations/{id}/toggle_status
 * - GET  /api/v1/accounts/{accountId}/contacts/search?q=           (identifier lookup for reconciliation)
 * - POST /api/v1/accounts/{accountId}/contacts
 *
 * Reconciliation contract: an ambiguous remote write (timeout, network error, 5xx, lost response)
 * throws DomainError with code UNKNOWN_OUTCOME. Callers must then reconcile — never blindly retry:
 * conversations are deduped by the deterministic `source_id` (filter_by_source_id joins
 * contact_inboxes), contacts by the stable identifier `qeynox:{userId}:{workspaceId}`,
 * messages by their `source_id` inside the conversation history.
 *
 * Chatwoot webhooks are not required: QeyNox reads conversations live and stores no message.
 */
export class ChatwootClient implements ChatwootPort {
  readonly capability: SupportCapability;
  private readonly config: ChatwootConfig | null;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    const config = readConfig(env);
    this.config = config.config;
    if (this.config === null) {
      this.capability = { status: 'NOT_CONFIGURED', reason: config.missing.join('|'), inboxConfigured: false, webhooksRequired: false };
      return;
    }
    const verified = (env[CHATWOOT_LIVE_VERIFICATION_VAR] ?? '').trim() === 'true';
    this.capability = verified
      ? { status: 'CONFIGURED', reason: null, inboxConfigured: true, webhooksRequired: false }
      : { status: 'NOT_CONFIGURED', reason: 'CHATWOOT_LIVE_VERIFICATION_REQUIRED', inboxConfigured: true, webhooksRequired: false };
  }

  private requireConfig(): ChatwootConfig {
    if (!this.config) throw new DomainError('NOT_CONFIGURED', 'Chatwoot support is not configured: ' + (this.capability.reason ?? 'CHATWOOT_NOT_CONFIGURED'));
    if (this.capability.status !== 'CONFIGURED') {
      // Credentials exist but the operator has not verified the live integration yet: fail closed.
      throw new DomainError('NOT_CONFIGURED', 'Chatwoot live verification required: run docs/architecture/CHATWOOT_SUPPORT.md#live-verification against a real instance, then set ' + CHATWOOT_LIVE_VERIFICATION_VAR + '=true');
    }
    return this.config;
  }

  private async request(path: string, init: RequestInit = {}): Promise<{ readonly status: number; readonly body: unknown }> {
    const config = this.requireConfig();
    const url = config.baseUrl + '/api/v1/accounts/' + config.accountId + path;
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer ' + config.token,
          api_access_token: config.token,
          ...(init.headers ?? {}),
        },
        signal: AbortSignal.timeout(10_000),
        redirect: 'error',
      });
    } catch {
      // Timeout/reset/DNS: the remote may have processed the write. Ambiguous.
      throw new DomainError('UNKNOWN_OUTCOME', 'Chatwoot API outcome unknown (network error or timeout)');
    }
    const raw = await response.text();
    let body: unknown = null;
    try { body = raw.length ? JSON.parse(raw) : null; } catch { body = null; }
    if (response.status >= 500) {
      // 5xx: the remote may have processed the write before failing. Ambiguous.
      throw new DomainError('UNKNOWN_OUTCOME', 'Chatwoot API outcome unknown (' + response.status + ')');
    }
    if (!response.ok) throw new DomainError('UNAVAILABLE', 'Chatwoot API request failed (' + response.status + ')');
    return { status: response.status, body };
  }

  async createContact(input: { email: string; displayName: string; userId: string; workspaceId: string }): Promise<ChatwootContact> {
    const config = this.requireConfig();
    const response = await this.request('/contacts', {
      method: 'POST',
      body: JSON.stringify({
        inbox_id: Number(config.inboxId),
        name: input.displayName,
        email: input.email,
        identifier: 'qeynox:' + input.userId + ':' + input.workspaceId,
        custom_attributes: { qeynox_user_id: input.userId, qeynox_workspace_id: input.workspaceId },
      }),
    });
    const payload = asRecord(payloadOf(response.body));
    const contact = asRecord(payload.contact ?? payload);
    const id = asText(contact.id);
    if (!id) throw new DomainError('UNAVAILABLE', 'Chatwoot did not return a contact id');
    return { id, name: asText(contact.name), email: asText(contact.email) };
  }

  /** Exact-identifier contact lookup; used to reconcile ambiguous contact creation. Deterministic pick (lowest id) on duplicates. */
  async findContactByIdentifier(identifier: string): Promise<ChatwootContact | null> {
    const query = new URLSearchParams({ q: identifier });
    const response = await this.request('/contacts/search?' + query.toString());
    const matches: ChatwootContact[] = [];
    for (const raw of asArray(payloadOf(response.body))) {
      const contact = asRecord(asRecord(raw).payload ?? raw);
      const id = asText(contact.id);
      if (id && asText(contact.identifier) === identifier) {
        matches.push({ id, name: asText(contact.name), email: asText(contact.email) });
      }
    }
    matches.sort((a, b) => Number(a.id) - Number(b.id));
    return matches[0] ?? null;
  }

  async createConversation(input: { contactId: string; sourceId: string }): Promise<SupportConversation> {
    const config = this.requireConfig();
    const response = await this.request('/conversations', {
      method: 'POST',
      body: JSON.stringify({ inbox_id: Number(config.inboxId), contact_id: Number(input.contactId), source_id: input.sourceId, status: 'open' }),
    });
    const raw = payloadOf(response.body);
    const conversation = normalizeConversation(Array.isArray(raw) ? raw[0] : raw);
    if (conversation.id === 'unknown') throw new DomainError('UNAVAILABLE', 'Chatwoot did not return a conversation id');
    return conversation;
  }

  /** Reconciliation lookup: conversations whose contact_inbox carries the given source_id (filter_by_source_id). */
  async findConversationsBySourceId(sourceId: string): Promise<readonly SupportConversation[]> {
    const query = new URLSearchParams({ source_id: sourceId, status: 'all', assignee_type: 'all', page: '1' });
    const response = await this.request('/conversations?' + query.toString());
    return asArray(payloadOf(response.body)).map(normalizeConversation).filter(conversation => conversation.id !== 'unknown');
  }

  async getConversation(chatwootConversationId: string): Promise<SupportConversationDetail | null> {
    try {
      const conversationResponse = await this.request('/conversations/' + encodeURIComponent(chatwootConversationId));
      const rawConversation = payloadOf(conversationResponse.body);
      const conversation = normalizeConversation(rawConversation);
      const messagesResponse = await this.request('/conversations/' + encodeURIComponent(chatwootConversationId) + '/messages');
      const messages = asArray(payloadOf(messagesResponse.body)).map(normalizeMessage);
      return { conversation, messages };
    } catch (error) {
      if (error instanceof DomainError && error.code === 'UNAVAILABLE' && error.message.includes('(404)')) return null;
      throw error;
    }
  }

  async listConversations(input: { status?: string | undefined; page?: number | undefined }): Promise<SupportConversationList> {
    const page = Number.isInteger(input.page) && (input.page ?? 0) >= 1 ? Number(input.page) : 1;
    const query = new URLSearchParams({ assignee_type: 'all', page: String(page) });
    if (input.status && input.status !== 'all') query.set('status', input.status);
    const perPage = 25;
    const response = await this.request('/conversations?' + query.toString());
    const conversations = asArray(payloadOf(response.body)).map(normalizeConversation);
    const meta = metaOf(response.body);
    const totalCount = asNumber(meta.all_count);
    const hasMore = totalCount === null ? conversations.length === perPage : page * perPage < totalCount;
    return { conversations, page, perPage, totalCount, hasMore };
  }

  async sendMessage(chatwootConversationId: string, content: string, direction: 'incoming' | 'outgoing', sourceId?: string): Promise<SupportMessage> {
    const response = await this.request('/conversations/' + encodeURIComponent(chatwootConversationId) + '/messages', {
      method: 'POST',
      body: JSON.stringify({ content, message_type: direction, private: false, ...(sourceId ? { source_id: sourceId } : {}) }),
    });
    const payload = payloadOf(response.body);
    return normalizeMessage(Array.isArray(payload) ? payload[0] : payload);
  }

  async updateStatus(chatwootConversationId: string, status: 'open' | 'pending' | 'resolved'): Promise<void> {
    // toggle_status answers 204 with no meaningful body on current Chatwoot versions: callers re-read the conversation for the authoritative state.
    await this.request('/conversations/' + encodeURIComponent(chatwootConversationId) + '/toggle_status', {
      method: 'POST',
      body: JSON.stringify({ status }),
    });
  }
}

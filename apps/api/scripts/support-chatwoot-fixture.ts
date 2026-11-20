/**
 * Deterministic Chatwoot REST fixture for QA suites.
 *
 * It implements just enough of the documented Chatwoot API (contacts, contact search,
 * conversations, messages, toggle_status) to exercise the QeyNox adapter's contract: request
 * shapes, response envelopes, source_id reconciliation and ambiguous-outcome failure injection.
 *
 * It is NOT a Chatwoot and proves nothing about a live deployment — every suite using it prints
 * "fixture only" wording. Failure injection modes persist the write remotely and then destroy the
 * connection or answer 500, reproducing the "remote may have processed it" ambiguity.
 */
import { createServer, type Server } from 'node:http';

export type FixtureCrashMode =
  | 'crash-after-contact-create'
  | 'crash-after-conversation-create'
  | 'crash-after-message-create'
  | 'fail-500-after-contact-create'
  | 'fail-500-after-conversation-create'
  | 'fail-500-after-message-create'
  | 'fail-500-on-send-message';

export interface FixtureContact { id: number; name: string | null; email: string | null; identifier: string | null }
export interface FixtureConversation {
  id: number; inboxId: number; contactId: number; sourceId: string | null;
  status: string; priority: string | null; createdAt: number; lastActivityAt: number;
}
export interface FixtureMessage {
  id: number; conversationId: number; content: string; messageType: number;
  private: boolean; sourceId: string | null; createdAt: number;
}

export interface ChatwootFixture {
  readonly url: string;
  readonly requests: Array<{ method: string; path: string }>;
  readonly contacts: FixtureContact[];
  readonly conversations: FixtureConversation[];
  readonly messages: FixtureMessage[];
  /** Arm one-shot failure injection for the next matching mutating request. */
  arm(mode: FixtureCrashMode): void;
  removeConversation(id: number): void;
  close(): Promise<void>;
}

const messageTypeNumbers: Record<string, number> = { incoming: 0, outgoing: 1, activity: 2, template: 3 };

export async function createChatwootFixture(options: { readonly accountId?: number; readonly inboxId?: number; readonly token?: string } = {}): Promise<ChatwootFixture> {
  const accountId = options.accountId ?? 1;
  const inboxId = options.inboxId ?? 2;
  const token = options.token ?? 'qa-token';
  const base = '/api/v1/accounts/' + accountId;

  const contacts: FixtureContact[] = [];
  const conversations: FixtureConversation[] = [];
  const messages: FixtureMessage[] = [];
  const requests: Array<{ method: string; path: string }> = [];
  let nextContactId = 11;
  let nextConversationId = 101;
  let nextMessageId = 1001;
  let armed: FixtureCrashMode | null = null;

  const conversationJson = (conversation: FixtureConversation) => {
    const contact = contacts.find(item => item.id === conversation.contactId) ?? null;
    return {
      id: conversation.id,
      inbox_id: conversation.inboxId,
      status: conversation.status,
      priority: conversation.priority,
      created_at: conversation.createdAt,
      updated_at: conversation.lastActivityAt,
      last_activity_at: conversation.lastActivityAt,
      meta: {
        sender: contact ? { id: contact.id, name: contact.name, email: contact.email } : null,
        assignee: null,
      },
      messages: messages.filter(message => message.conversationId === conversation.id).slice(-1).map(message => ({
        id: message.id, content: message.content, message_type: message.messageType, private: message.private, source_id: message.sourceId, created_at: message.createdAt,
      })),
    };
  };
  const messageJson = (message: FixtureMessage) => ({
    id: message.id,
    content: message.content,
    message_type: message.messageType,
    private: message.private,
    source_id: message.sourceId,
    created_at: message.createdAt,
    sender: message.messageType === 0 ? { id: 11, name: 'QA customer', type: 'contact' } : { id: 7, name: 'QA operator', type: 'agent' },
  });

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fixture');
    const path = url.pathname;
    requests.push({ method: req.method ?? 'GET', path: path + (url.search || '') });
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(body === null ? '' : JSON.stringify(body));
    };
    if (req.headers['api_access_token'] !== token && req.headers.authorization !== 'Bearer ' + token) {
      send(401, { error: 'unauthorized' });
      return;
    }
    const crash = () => { req.socket.destroy(); };

    const readBody = async (): Promise<Record<string, unknown>> => {
      let text = '';
      for await (const chunk of req) text += chunk;
      try { return JSON.parse(text || '{}') as Record<string, unknown>; } catch { return {}; }
    };

    void (async () => {
      // ---- contacts ----------------------------------------------------------------------
      if (req.method === 'POST' && path === base + '/contacts') {
        const body = await readBody();
        const contact: FixtureContact = {
          id: nextContactId++,
          name: typeof body.name === 'string' ? body.name : null,
          email: typeof body.email === 'string' ? body.email : null,
          identifier: typeof body.identifier === 'string' ? body.identifier : null,
        };
        contacts.push(contact);
        if (armed === 'crash-after-contact-create') { armed = null; crash(); return; }
        if (armed === 'fail-500-after-contact-create') { armed = null; send(500, { error: 'boom' }); return; }
        send(200, { payload: { contact } });
        return;
      }
      if (req.method === 'GET' && path === base + '/contacts/search') {
        const q = url.searchParams.get('q') ?? '';
        send(200, { payload: contacts.filter(contact => (contact.identifier ?? '').includes(q)) });
        return;
      }
      // ---- conversations -----------------------------------------------------------------
      if (req.method === 'POST' && path === base + '/conversations') {
        const body = await readBody();
        const conversation: FixtureConversation = {
          id: nextConversationId++,
          inboxId: typeof body.inbox_id === 'number' ? body.inbox_id : inboxId,
          contactId: typeof body.contact_id === 'number' ? body.contact_id : Number(body.contact_id),
          sourceId: typeof body.source_id === 'string' ? body.source_id : null,
          status: typeof body.status === 'string' ? body.status : 'open',
          priority: null,
          createdAt: Math.floor(Date.now() / 1000),
          lastActivityAt: Math.floor(Date.now() / 1000),
        };
        conversations.push(conversation);
        if (armed === 'crash-after-conversation-create') { armed = null; crash(); return; }
        if (armed === 'fail-500-after-conversation-create') { armed = null; send(500, { error: 'boom' }); return; }
        send(200, conversationJson(conversation));
        return;
      }
      if (req.method === 'GET' && path === base + '/conversations') {
        const sourceId = url.searchParams.get('source_id');
        const statusParam = url.searchParams.get('status') ?? 'open';
        const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
        let filtered = conversations.slice();
        if (sourceId) filtered = filtered.filter(conversation => conversation.sourceId === sourceId);
        if (statusParam !== 'all') filtered = filtered.filter(conversation => conversation.status === statusParam);
        const allCount = filtered.length;
        const perPage = 25;
        const payload = filtered.slice((page - 1) * perPage, page * perPage).map(conversationJson);
        send(200, { data: { meta: { all_count: allCount, mine_count: allCount, unassigned_count: 0, assigned_count: 0 }, payload } });
        return;
      }
      const conversationMatch = /^\/api\/v1\/accounts\/\d+\/conversations\/(\d+)$/.exec(path);
      if (req.method === 'GET' && conversationMatch) {
        const id = Number(conversationMatch[1]);
        const conversation = conversations.find(item => item.id === id);
        if (!conversation) { send(404, { error: 'not found' }); return; }
        send(200, conversationJson(conversation));
        return;
      }
      const messagesMatch = /^\/api\/v1\/accounts\/\d+\/conversations\/(\d+)\/messages$/.exec(path);
      if (req.method === 'GET' && messagesMatch) {
        const id = Number(messagesMatch[1]);
        if (!conversations.some(item => item.id === id)) { send(404, { error: 'not found' }); return; }
        send(200, { payload: messages.filter(message => message.conversationId === id).map(messageJson) });
        return;
      }
      if (req.method === 'POST' && messagesMatch) {
        const id = Number(messagesMatch[1]);
        const conversation = conversations.find(item => item.id === id);
        if (!conversation) { send(404, { error: 'not found' }); return; }
        const body = await readBody();
        if (armed === 'fail-500-on-send-message') { armed = null; send(500, { error: 'boom before write' }); return; }
        const rawType = typeof body.message_type === 'string' ? body.message_type : 'outgoing';
        const message: FixtureMessage = {
          id: nextMessageId++,
          conversationId: id,
          content: typeof body.content === 'string' ? body.content : '',
          messageType: messageTypeNumbers[rawType] ?? 1,
          private: body.private === true,
          sourceId: typeof body.source_id === 'string' ? body.source_id : null,
          createdAt: Math.floor(Date.now() / 1000),
        };
        messages.push(message);
        conversation.lastActivityAt = message.createdAt;
        if (armed === 'crash-after-message-create') { armed = null; crash(); return; }
        if (armed === 'fail-500-after-message-create') { armed = null; send(500, { error: 'boom' }); return; }
        send(200, messageJson(message));
        return;
      }
      const toggleMatch = /^\/api\/v1\/accounts\/\d+\/conversations\/(\d+)\/toggle_status$/.exec(path);
      if (req.method === 'POST' && toggleMatch) {
        const id = Number(toggleMatch[1]);
        const conversation = conversations.find(item => item.id === id);
        if (!conversation) { send(404, { error: 'not found' }); return; }
        const body = await readBody();
        if (typeof body.status === 'string') { conversation.status = body.status; conversation.lastActivityAt = Math.floor(Date.now() / 1000); }
        res.writeHead(204);
        res.end();
        return;
      }
      send(404, { error: 'fixture route not implemented: ' + (req.method ?? '?') + ' ' + path });
    })().catch(error => { res.writeHead(500); res.end(String(error)); });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture failed to listen');

  return {
    url: 'http://127.0.0.1:' + address.port,
    requests,
    contacts,
    conversations,
    messages,
    arm(mode: FixtureCrashMode) { armed = mode; },
    removeConversation(id: number) {
      const index = conversations.findIndex(item => item.id === id);
      if (index >= 0) conversations.splice(index, 1);
      for (let i = messages.length - 1; i >= 0; i--) if (messages[i]?.conversationId === id) messages.splice(i, 1);
    },
    close: () => new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve()))),
  };
}

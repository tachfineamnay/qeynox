import type { ID } from './identities';

/**
 * Customer support integration contract (Chatwoot is the external support engine).
 *
 * QeyNox stores no support messages: conversations, messages, status and priority are read live
 * from the Chatwoot API. The only persisted support data is the account ↔ Chatwoot
 * contact/conversation mapping needed for authorization and tenant isolation.
 */
export type SupportCapability = Readonly<{
  status: 'CONFIGURED' | 'NOT_CONFIGURED';
  reason: string | null;
  inboxConfigured: boolean;
  webhooksRequired: false;
}>;

export type SupportLink = Readonly<{
  id: ID;
  userId: ID;
  workspaceId: ID;
  chatwootContactId: string;
  chatwootConversationId: string;
  state: 'ACTIVE' | 'ORPHANED';
  createdAt: string;
  updatedAt: string;
}>;

/** Durable intent-to-create record: the deterministic Chatwoot source_id for one open request. */
export type SupportIntentState = 'PENDING_CONTACT' | 'PENDING_CONVERSATION' | 'LINKED' | 'FAILED' | 'ORPHANED';
export type SupportIntent = Readonly<{
  id: ID;
  userId: ID;
  workspaceId: ID;
  intentRef: string;
  chatwootContactId: string | null;
  chatwootConversationId: string | null;
  state: SupportIntentState;
  failureCode: string | null;
  createdAt: string;
  updatedAt: string;
}>;

export type SupportConversation = Readonly<{
  id: string;
  status: string;
  priority: string | null;
  inboxId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  lastMessageAt: string | null;
  contact: Readonly<{ id: string | null; name: string | null; email: string | null }>;
  assignee: Readonly<{ id: string | null; name: string | null }> | null;
}>;

export type SupportMessage = Readonly<{
  id: string;
  content: string;
  messageType: string;
  private: boolean;
  sourceId: string | null;
  createdAt: string;
  sender: Readonly<{ id: string | null; name: string | null; type: string | null }> | null;
}>;

export type SupportConversationDetail = Readonly<{
  conversation: SupportConversation;
  messages: readonly SupportMessage[];
}>;

export type SupportConversationWithLink = Readonly<{
  conversation: SupportConversation;
  qeynox: Readonly<{ userId: ID; workspaceId: ID }> | null;
}>;

export type SupportActorProfile = Readonly<{
  email: string;
  displayName: string;
  workspaceName: string;
}>;

export type SupportConversationList = Readonly<{
  conversations: readonly SupportConversation[];
  page: number;
  perPage: number;
  totalCount: number | null;
  hasMore: boolean;
}>;

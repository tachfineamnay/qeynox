export interface PlatformMeView {
  userId: string;
  roles: string[];
  permissions: string[];
  sessionExpiresAt: string;
}

export interface UserSummaryView {
  userId: string;
  email: string;
  locale: string;
  createdAt: string;
  status: 'ACTIVE' | 'SUSPENDED';
  disabledAt: string | null;
  workspaceCount: number;
}
export interface UserPageView { items: UserSummaryView[]; nextCursor: string | null; limit: number }

export interface UserWorkspaceView {
  workspaceId: string; name: string; role: string; membershipStatus: string; workspaceCreatedAt: string;
}
export interface UserDetailView {
  userId: string; email: string; locale: string; createdAt: string;
  status: 'ACTIVE' | 'SUSPENDED'; disabledAt: string | null;
  workspaces: UserWorkspaceView[];
  sessions: {
    total: number; active: number; lastUsedAt: string | null;
    platformSessions?: { total: number; active: number; lastUsedAt: string | null };
  };
  platformRoles?: string[];
  onboarding?: {
    workspaceId: string;
    status: 'NOT_STARTED' | 'IN_PROGRESS' | 'PAUSED' | 'COMPLETED' | 'DISMISSED';
    step: string | null;
    startedAt: string | null;
    updatedAt: string | null;
    completedAt: string | null;
  }[];
}

export interface UserSessionView {
  sessionId: string; createdAt: string; expiresAt: string; revokedAt: string | null; lastUsedAt: string | null; active: boolean;
}
export interface UserSessionsView {
  userId: string; sessions: UserSessionView[];
  summary: { total: number; active: number; lastUsedAt: string | null };
  platformSessions?: UserSessionView[];
  platformSummary?: { total: number; active: number; lastUsedAt: string | null };
  truncated: boolean;
}

export interface ActivityItemView {
  source: 'IDENTITY' | 'PLATFORM'; id: string; action: string; outcome: string;
  happenedAt: string; actorUserId: string | null; reason: string | null; permission: string | null;
}
export interface ActivityPageView { items: ActivityItemView[]; nextCursor: string | null; limit: number }

export interface CapabilitiesView {
  emailTransport: 'CONFIGURED' | 'NOT_CONFIGURED';
  features: { feature: string; status: 'AVAILABLE' | 'BLOCKED'; reason: string }[];
  note: string;
}

export interface OrganizationSummaryView {
  workspaceId: string; name: string; createdBy: string; creatorEmail: string | null;
  createdAt: string; activeMembers: number; owners: number; invited: number;
}
export interface OrganizationPageView { items: OrganizationSummaryView[]; nextCursor: string | null; limit: number }
export interface OrganizationDetailView extends OrganizationSummaryView {
  stats: { activeMembers: number; owners: number; admins: number; members: number; invited: number };
}
export interface MemberView {
  membershipId: string; userId: string; email: string; role: string; status: string;
  invitedBy: string | null; invitedAt: string | null; joinedAt: string | null;
  updatedAt: string | null; userDisabledAt: string | null;
}
export interface MemberPageView { items: MemberView[]; nextCursor: string | null; limit: number }

export interface AuditEntryView {
  id: string; actorUserId: string | null; actorSessionId: string | null;
  targetType: string; targetId: string | null; action: string; permission: string | null;
  outcome: 'SUCCESS' | 'DENIED' | 'ERROR'; reason: string | null;
  detail: Record<string, unknown> | null; happenedAt: string;
}

export interface InviteState {
  status: 'idle' | 'ok' | 'error';
  code?: string;
  token?: string;
  delivery?: { email: string; reason: string };
  expiresAt?: string;
  workspaceId?: string;
}

export interface SupportCapabilityView {
  status: 'CONFIGURED' | 'NOT_CONFIGURED';
  reason: string | null;
  inboxConfigured: boolean;
  webhooksRequired: false;
}
export interface SupportConversationView {
  id: string; status: string; priority: string | null; inboxId: string | null;
  createdAt: string | null; updatedAt: string | null; lastMessageAt: string | null;
  contact: { id: string | null; name: string | null; email: string | null };
  assignee: { id: string | null; name: string | null } | null;
}
export interface SupportMessageView {
  id: string; content: string; messageType: string; private: boolean; createdAt: string;
  sender: { id: string | null; name: string | null; type: string | null } | null;
}
export interface PlatformSupportConversationView {
  conversation: SupportConversationView;
  qeynox: { userId: string; workspaceId: string } | null;
}
export interface PlatformSupportConversationDetailView extends PlatformSupportConversationView {
  messages: SupportMessageView[];
}

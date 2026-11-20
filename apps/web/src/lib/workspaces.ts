import { z } from 'zod';

/** MISSION A18 — wire contracts for account & workspace self-service. */
export const workspaceSummarySchema = z.object({ workspaceId: z.string(), name: z.string(), role: z.string() });
export type WorkspaceSummary = z.infer<typeof workspaceSummarySchema>;
export const workspaceListSchema = z.object({ userId: z.string(), currentWorkspaceId: z.string(), workspaces: z.array(workspaceSummarySchema) });

export const profileSchema = z.object({
  email: z.string(), locale: z.string(), createdAt: z.string(), verifiedAt: z.string().nullable(), activeWorkspaceCount: z.number().int().nonnegative(),
});
export type ProfileView = z.infer<typeof profileSchema>;

export const sessionViewSchema = z.object({
  id: z.string(), createdAt: z.string(), lastUsedAt: z.string().nullable(), expiresAt: z.string(), current: z.boolean(),
});
export type SessionView = z.infer<typeof sessionViewSchema>;

export const deletionRequestSchema = z.object({
  id: z.string(), status: z.enum(['REQUESTED', 'CANCELLED']), reason: z.string().nullable(), createdAt: z.string(), updatedAt: z.string(),
});
export type DeletionRequest = z.infer<typeof deletionRequestSchema>;
export const profileUpdateSchema = z.object({ locale: z.string() });
export const overviewSchema = z.object({
  workspaceId: z.string(), name: z.string(), createdAt: z.string(),
  myRole: z.enum(['OWNER', 'ADMIN', 'MEMBER']),
  stats: z.object({ activeMembers: z.number().int(), owners: z.number().int(), admins: z.number().int(), members: z.number().int(), invited: z.number().int() }).nullable(),
});
export type OverviewView = z.infer<typeof overviewSchema>;

export const memberViewSchema = z.object({
  membershipId: z.string(), userId: z.string(), email: z.string(), role: z.string(), status: z.string(),
  invitedAt: z.string().nullable(), joinedAt: z.string().nullable(), updatedAt: z.string().nullable(),
  disabled: z.boolean(), isSelf: z.boolean(),
});
export type MemberView = z.infer<typeof memberViewSchema>;
export const membersPageSchema = z.object({ items: z.array(memberViewSchema), nextCursor: z.string().nullable(), limit: z.number().int() });

export const invitationViewSchema = z.object({
  membershipId: z.string(), userId: z.string(), email: z.string(), role: z.enum(['OWNER', 'ADMIN', 'MEMBER']),
  invitationToken: z.string(), invitationExpiresAt: z.string(),
  delivery: z.object({ email: z.literal('BLOCKED'), reason: z.literal('EMAIL_PROVIDER_NOT_CONFIGURED') }),
});
export type InvitationView = z.infer<typeof invitationViewSchema>;

export const invitationInboxItemSchema = z.object({
  membershipId: z.string(), workspaceId: z.string(), workspaceName: z.string(), role: z.string(),
  invitedByEmail: z.string().nullable().optional(), invitedAt: z.string().nullable().optional(),
});
export type InvitationInboxItem = z.infer<typeof invitationInboxItemSchema>;

/** Wire shape of `WorkspaceInvitationView` from @qeynox/application — permissive on the extras. */
export const invitationInboxSchema = z.array(z.looseObject({
  membershipId: z.string(), workspaceId: z.string(), workspaceName: z.string(), role: z.string(),
}));

/** Result of an accept/decline invitation call. */
export const invitationResponseSchema = z.looseObject({ status: z.string() });

import { DomainError } from './errors';

/**
 * Workspace (organisation) roles. Workspaces remain the single organisation entity stored in
 * identity_workspaces; these values are the only accepted membership roles.
 */
export const WORKSPACE_ROLES = ['OWNER', 'ADMIN', 'MEMBER'] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

/** Membership lifecycle. INVITED/ACTIVE grant or prepare access; REVOKED/DECLINED never do. */
export const MEMBERSHIP_STATUSES = ['ACTIVE', 'INVITED', 'REVOKED', 'DECLINED'] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

export function isWorkspaceRole(value: unknown): value is WorkspaceRole {
  return typeof value === 'string' && (WORKSPACE_ROLES as readonly string[]).includes(value);
}

export function isMembershipStatus(value: unknown): value is MembershipStatus {
  return typeof value === 'string' && (MEMBERSHIP_STATUSES as readonly string[]).includes(value);
}

export function requireWorkspaceRole(value: unknown): WorkspaceRole {
  if (!isWorkspaceRole(value)) throw new DomainError('INVALID_INPUT', 'Unknown workspace role');
  return value;
}

/** Roles able to administer a workspace. Recorded for future workspace-scoped management. */
export function isWorkspaceAdministrator(role: WorkspaceRole): boolean {
  return role === 'OWNER' || role === 'ADMIN';
}

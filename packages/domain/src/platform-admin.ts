import { DomainError } from './errors';
import type { ID } from './identities';

/**
 * QeyNox-internal platform roles.
 *
 * These values are deliberately distinct from the workspace roles stored in
 * identity_memberships (OWNER / ADMIN / MEMBER). A workspace role never grants platform
 * access, and a platform session never selects, joins or grants a workspace. Keeping the
 * vocabularies disjoint makes a privilege leak visible in code review instead of silent.
 */
export const PLATFORM_ROLES = ['PLATFORM_ADMIN', 'SUPPORT', 'OPERATIONS', 'AUDITOR'] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];

/** Minimal platform permissions: general administration, support, technical operations, consultation. */
export const PLATFORM_PERMISSIONS = ['ADMINISTRATION', 'SUPPORT', 'OPERATIONS', 'CONSULTATION'] as const;
export type PlatformPermission = (typeof PLATFORM_PERMISSIONS)[number];

/**
 * Least privilege by default. General administration can manage platform administrators and read
 * the audit trail, but it does not silently absorb customer support or runtime operations, and
 * support/operations cannot read the administration list or the audit trail: consultation is an
 * explicit capability granted to PLATFORM_ADMIN and AUDITOR only. A person holds several
 * assignments when the job genuinely requires it.
 */
const rolePermissions: Readonly<Record<PlatformRole, readonly PlatformPermission[]>> = {
  PLATFORM_ADMIN: ['ADMINISTRATION', 'CONSULTATION'],
  SUPPORT: ['SUPPORT'],
  OPERATIONS: ['OPERATIONS'],
  AUDITOR: ['CONSULTATION'],
};

/** Authenticated platform administrator. Never derived from a workspace membership. */
export type PlatformPrincipal = Readonly<{
  userId: ID;
  sessionId: string;
  roles: readonly PlatformRole[];
  permissions: readonly PlatformPermission[];
  sessionExpiresAt: string;
}>;

export function isPlatformRole(value: unknown): value is PlatformRole {
  return typeof value === 'string' && (PLATFORM_ROLES as readonly string[]).includes(value);
}

/** Union of permissions granted by the given roles, in canonical order. */
export function platformPermissionsForRoles(roles: readonly PlatformRole[]): readonly PlatformPermission[] {
  const granted = new Set<PlatformPermission>();
  for (const role of roles) for (const permission of rolePermissions[role]) granted.add(permission);
  return PLATFORM_PERMISSIONS.filter(permission => granted.has(permission));
}

export function hasPlatformPermission(principal: PlatformPrincipal, permission: PlatformPermission): boolean {
  return principal.permissions.includes(permission);
}

export function requirePlatformPermission(principal: PlatformPrincipal, permission: PlatformPermission): void {
  if (!hasPlatformPermission(principal, permission)) {
    throw new DomainError('DENIED', 'Platform permission required: ' + permission);
  }
}

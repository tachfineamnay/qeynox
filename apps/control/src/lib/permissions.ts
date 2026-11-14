export type PlatformPermission = 'ADMINISTRATION' | 'SUPPORT' | 'OPERATIONS' | 'CONSULTATION';

export const READ_USERS = ['ADMINISTRATION', 'SUPPORT'] as const;
export const READ_ACTIVITY = ['ADMINISTRATION', 'SUPPORT', 'CONSULTATION'] as const;
export const ADMINISTRATION = ['ADMINISTRATION'] as const;
export const CONSULTATION = ['CONSULTATION'] as const;
export const READ_ORGANIZATIONS = ['ADMINISTRATION', 'SUPPORT'] as const;
export const LIFECYCLE_READ = ['ADMINISTRATION', 'SUPPORT', 'CONSULTATION'] as const;

export function can(permissions: readonly string[], required: readonly string[]): boolean {
  return required.some(permission => permissions.includes(permission));
}

export const SUPPORT = ['SUPPORT'] as const;

export const OPERATIONS = ['OPERATIONS'] as const;

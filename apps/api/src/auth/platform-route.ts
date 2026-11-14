import { SetMetadata } from '@nestjs/common';
import type { PlatformPermission } from '@qeynox/domain';

/**
 * Marks a controller as global platform administration.
 *
 * The workspace AuthenticationGuard deliberately skips these routes: they authenticate against
 * platform_admin_sessions through PlatformAccessGuard. Skipping the workspace guard never grants
 * workspace authority — a platform principal carries no workspace id and cannot call tenant
 * routes, and a workspace bearer token is unknown to the platform session store.
 */
export const PLATFORM_ROUTE_KEY = 'qeynox:platform-route';
export const PlatformRoute = () => SetMetadata(PLATFORM_ROUTE_KEY, true);

/** Mandatory per-route access policy. A platform route without one fails closed. */
export const PLATFORM_ACCESS_KEY = 'qeynox:platform-access';
/**
 * A single permission, an any-of permission list, a valid platform session for the caller
 * ('SELF'), or the unauthenticated platform sign-in route. An array grants access when the
 * principal holds at least one of the listed permissions.
 */
export type PlatformAccessPolicy = PlatformPermission | readonly PlatformPermission[] | 'SELF' | 'PUBLIC_LOGIN';
export const PlatformAccess = (policy: PlatformAccessPolicy) => SetMetadata(PLATFORM_ACCESS_KEY, policy);

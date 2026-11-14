import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DomainError, type PlatformPrincipal } from '@qeynox/domain';
import type { PlatformAdminService } from '@qeynox/application';
import { PLATFORM_ACCESS_KEY, PLATFORM_ROUTE_KEY, type PlatformAccessPolicy } from '../auth/platform-route';
import { PLATFORM_ADMIN_SERVICE } from './platform.tokens';
import type { PlatformRequest } from './platform.request';

const bearerPattern = /^Bearer ([A-Za-z0-9_-]{32,256})$/;

/**
 * Global guard for the platform administration surface.
 *
 * Registered as APP_GUARD so a platform route cannot be added without evaluation. Non-platform
 * routes are ignored (the workspace guard owns them). Fail-closed properties:
 * - a @PlatformAccess policy on a controller that is not @PlatformRoute is denied and audited;
 * - a platform route without a declared policy is denied and audited;
 * - a missing or malformed bearer is denied and audited (actor unknown);
 * - every permission denial is written to the platform audit trail.
 */
@Injectable()
export class PlatformAccessGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(PLATFORM_ADMIN_SERVICE) private readonly platform: PlatformAdminService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    const handlerName = context.getHandler().name;
    const platformRoute = this.reflector.getAllAndOverride<boolean>(PLATFORM_ROUTE_KEY, targets) === true;
    const policy = this.reflector.getAllAndOverride<PlatformAccessPolicy>(PLATFORM_ACCESS_KEY, targets);
    if (!platformRoute) {
      if (policy !== undefined) {
        await this.platform.recordAccessDenial({ action: 'PLATFORM_ACCESS', targetType: 'PLATFORM_ROUTE', targetId: handlerName, reason: 'POLICY_WITHOUT_PLATFORM_ROUTE' });
        throw new DomainError('DENIED', 'Platform access policy declared on a non-platform route');
      }
      return true;
    }
    if (!policy) {
      await this.platform.recordAccessDenial({ action: 'PLATFORM_ACCESS', targetType: 'PLATFORM_ROUTE', targetId: handlerName, reason: 'MISSING_ACCESS_POLICY' });
      throw new DomainError('DENIED', 'Platform route has no declared access policy');
    }
    if (policy === 'PUBLIC_LOGIN') return true;
    const request = context.switchToHttp().getRequest<PlatformRequest>();
    const authorization = request.headers.authorization;
    const match = typeof authorization === 'string' ? bearerPattern.exec(authorization) : null;
    const token = match?.[1];
    if (!token) {
      await this.platform.recordAccessDenial({
        action: 'PLATFORM_ACCESS', targetType: 'PLATFORM_ROUTE', targetId: handlerName,
        permission: policy === 'SELF' ? null : policy,
        reason: authorization === undefined ? 'MISSING_SESSION' : 'MALFORMED_SESSION_TOKEN',
      });
      throw new DomainError('DENIED', 'Platform bearer session required');
    }
    const principal: PlatformPrincipal = await this.platform.authenticate(token);
    if (policy !== 'SELF') {
      await this.platform.requirePermission(principal, policy, {
        action: 'PLATFORM_ACCESS',
        targetType: 'PLATFORM_ROUTE',
        targetId: handlerName,
      });
    }
    request.platformPrincipal = principal;
    return true;
  }
}

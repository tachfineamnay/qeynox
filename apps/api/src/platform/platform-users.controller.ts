import { Body, Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { ZodError, z } from 'zod';
import { idSchema } from '@qeynox/contracts';
import { DomainError, type PlatformPrincipal } from '@qeynox/domain';
import type {
  AccountCapabilities,
  PlatformUserActivityPage,
  PlatformUserDetail,
  PlatformUserPage,
  PlatformUserSessionsRevocationView,
  PlatformUserSessionsView,
  PlatformUserStatusView,
  PlatformUsersService,
  PlatformPermissionContext,
} from '@qeynox/application';
import { PlatformAccess, PlatformRoute } from '../auth/platform-route';
import { PLATFORM_USERS_SERVICE } from './platform.tokens';
import type { PlatformRequest } from './platform.request';

const platformUserRead: readonly ('ADMINISTRATION' | 'SUPPORT')[] = ['ADMINISTRATION', 'SUPPORT'];
const platformUserActivity: readonly ('ADMINISTRATION' | 'SUPPORT' | 'CONSULTATION')[] = ['ADMINISTRATION', 'SUPPORT', 'CONSULTATION'];

const listQuerySchema = z.object({
  query: z.string().max(320).optional(),
  status: z.enum(['ACTIVE', 'SUSPENDED']).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).max(512).optional(),
});
const activityQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).max(512).optional(),
});
const reasonSchema = z.object({ reason: z.string().trim().min(10).max(500) });
const invitationSchema = z.object({ email: z.email(), reason: z.string().trim().min(10).max(500) });

function principal(request: PlatformRequest): PlatformPrincipal {
  if (!request.platformPrincipal) throw new DomainError('DENIED', 'Platform session required');
  return request.platformPrincipal;
}

async function parseOrAudit<T>(
  service: PlatformUsersService,
  schema: z.ZodType<T>,
  value: unknown,
  request: PlatformRequest,
  context: PlatformPermissionContext,
): Promise<T> {
  try {
    return schema.parse(value);
  } catch (error: unknown) {
    if (error instanceof ZodError) await service.recordInputRejection(request.platformPrincipal, context);
    throw error;
  }
}

/**
 * Platform user administration over the existing identity tables.
 *
 * Read routes accept ADMINISTRATION or SUPPORT; the activity timeline also accepts CONSULTATION
 * (auditor). Every mutation requires ADMINISTRATION, a written justification and is audited.
 * Invitation, e-mail verification and account recovery return 503 NOT_CONFIGURED while the e-mail
 * transport is absent — no message is ever claimed to be sent.
 */
@PlatformRoute()
@Controller('v1/platform/users')
export class PlatformUsersController {
  constructor(@Inject(PLATFORM_USERS_SERVICE) private readonly users: PlatformUsersService) {}

  /** Paginated user directory, optional e-mail search and status filter. */
  @PlatformAccess(platformUserRead)
  @Get()
  async list(@Req() request: PlatformRequest, @Query() query: Record<string, unknown>): Promise<PlatformUserPage> {
    const actor = principal(request);
    const parsed = await parseOrAudit(this.users, listQuerySchema, query, request, { action: 'LIST_PLATFORM_USERS', targetType: 'USER_DIRECTORY' });
    return this.users.list(actor, parsed);
  }

  /** Explicit account-lifecycle capability status; unavailable features stay BLOCKED. */
  @PlatformAccess(platformUserActivity)
  @Get('capabilities')
  capabilities(@Req() request: PlatformRequest): Promise<AccountCapabilities> {
    return this.users.capabilities(principal(request));
  }

  /** Blocked: no invitation is created and no e-mail is sent without a configured transport. */
  @PlatformAccess('ADMINISTRATION')
  @Post('invitations')
  async requestInvitation(@Req() request: PlatformRequest, @Body() body: unknown): Promise<never> {
    const actor = principal(request);
    const input = await parseOrAudit(this.users, invitationSchema, body, request, { action: 'REQUEST_INVITATION', targetType: 'INVITATION' });
    return this.users.requestInvitation(actor, input);
  }

  @PlatformAccess(platformUserRead)
  @Get(':userId')
  async detail(@Req() request: PlatformRequest, @Param('userId') userId: string): Promise<PlatformUserDetail> {
    const actor = principal(request);
    const parsedId = await parseOrAudit(this.users, idSchema, userId, request, { action: 'READ_PLATFORM_USER', targetType: 'IDENTITY_ACCOUNT', targetId: userId });
    return this.users.get(actor, parsedId);
  }

  @PlatformAccess(platformUserRead)
  @Get(':userId/sessions')
  async sessions(@Req() request: PlatformRequest, @Param('userId') userId: string): Promise<PlatformUserSessionsView> {
    const actor = principal(request);
    const parsedId = await parseOrAudit(this.users, idSchema, userId, request, { action: 'LIST_USER_SESSIONS', targetType: 'IDENTITY_ACCOUNT', targetId: userId });
    return this.users.listSessions(actor, parsedId);
  }

  @PlatformAccess(platformUserActivity)
  @Get(':userId/activity')
  async activity(@Req() request: PlatformRequest, @Param('userId') userId: string, @Query() query: Record<string, unknown>): Promise<PlatformUserActivityPage> {
    const actor = principal(request);
    const parsedId = await parseOrAudit(this.users, idSchema, userId, request, { action: 'READ_USER_ACTIVITY', targetType: 'IDENTITY_ACCOUNT', targetId: userId });
    const parsed = await parseOrAudit(this.users, activityQuerySchema, query, request, { action: 'READ_USER_ACTIVITY', targetType: 'IDENTITY_ACCOUNT', targetId: parsedId });
    return this.users.activity(actor, parsedId, parsed);
  }

  @PlatformAccess('ADMINISTRATION')
  @Post(':userId/suspend')
  async suspend(@Req() request: PlatformRequest, @Param('userId') userId: string, @Body() body: unknown): Promise<PlatformUserStatusView> {
    const actor = principal(request);
    const parsedId = await parseOrAudit(this.users, idSchema, userId, request, { action: 'SUSPEND_PLATFORM_USER', targetType: 'IDENTITY_ACCOUNT', targetId: userId });
    const input = await parseOrAudit(this.users, reasonSchema, body, request, { action: 'SUSPEND_PLATFORM_USER', targetType: 'IDENTITY_ACCOUNT', targetId: parsedId });
    return this.users.suspend(actor, parsedId, input);
  }

  @PlatformAccess('ADMINISTRATION')
  @Post(':userId/reactivate')
  async reactivate(@Req() request: PlatformRequest, @Param('userId') userId: string, @Body() body: unknown): Promise<PlatformUserStatusView> {
    const actor = principal(request);
    const parsedId = await parseOrAudit(this.users, idSchema, userId, request, { action: 'REACTIVATE_PLATFORM_USER', targetType: 'IDENTITY_ACCOUNT', targetId: userId });
    const input = await parseOrAudit(this.users, reasonSchema, body, request, { action: 'REACTIVATE_PLATFORM_USER', targetType: 'IDENTITY_ACCOUNT', targetId: parsedId });
    return this.users.reactivate(actor, parsedId, input);
  }

  @PlatformAccess('ADMINISTRATION')
  @Post(':userId/sessions/revoke')
  async revokeSessions(@Req() request: PlatformRequest, @Param('userId') userId: string, @Body() body: unknown): Promise<PlatformUserSessionsRevocationView> {
    const actor = principal(request);
    const parsedId = await parseOrAudit(this.users, idSchema, userId, request, { action: 'REVOKE_USER_SESSIONS', targetType: 'IDENTITY_ACCOUNT', targetId: userId });
    const input = await parseOrAudit(this.users, reasonSchema, body, request, { action: 'REVOKE_USER_SESSIONS', targetType: 'IDENTITY_ACCOUNT', targetId: parsedId });
    return this.users.revokeSessions(actor, parsedId, input);
  }

  /** Blocked: no verification e-mail is sent without a configured transport. */
  @PlatformAccess('ADMINISTRATION')
  @Post(':userId/email-verification')
  async requestEmailVerification(@Req() request: PlatformRequest, @Param('userId') userId: string, @Body() body: unknown): Promise<never> {
    const actor = principal(request);
    const parsedId = await parseOrAudit(this.users, idSchema, userId, request, { action: 'REQUEST_EMAIL_VERIFICATION', targetType: 'IDENTITY_ACCOUNT', targetId: userId });
    const input = await parseOrAudit(this.users, reasonSchema, body, request, { action: 'REQUEST_EMAIL_VERIFICATION', targetType: 'IDENTITY_ACCOUNT', targetId: parsedId });
    return this.users.requestEmailVerification(actor, parsedId, input);
  }

  /** Blocked: no recovery e-mail is sent without a configured transport. */
  @PlatformAccess('ADMINISTRATION')
  @Post(':userId/account-recovery')
  async requestAccountRecovery(@Req() request: PlatformRequest, @Param('userId') userId: string, @Body() body: unknown): Promise<never> {
    const actor = principal(request);
    const parsedId = await parseOrAudit(this.users, idSchema, userId, request, { action: 'REQUEST_ACCOUNT_RECOVERY', targetType: 'IDENTITY_ACCOUNT', targetId: userId });
    const input = await parseOrAudit(this.users, reasonSchema, body, request, { action: 'REQUEST_ACCOUNT_RECOVERY', targetType: 'IDENTITY_ACCOUNT', targetId: parsedId });
    return this.users.requestAccountRecovery(actor, parsedId, input);
  }
}

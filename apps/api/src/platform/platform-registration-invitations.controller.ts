import { Body, Controller, Get, Header, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { ZodError, z } from 'zod';
import { idSchema } from '@qeynox/contracts';
import { DomainError, type PlatformPermission, type PlatformPrincipal } from '@qeynox/domain';
import type {
  PlatformPermissionContext,
  PlatformRegistrationInvitationService,
  RegistrationInvitationCreatedView,
  RegistrationInvitationPage,
  RegistrationInvitationView,
} from '@qeynox/application';
import { PlatformAccess, PlatformRoute } from '../auth/platform-route';
import { PLATFORM_REGISTRATION_INVITATION_SERVICE } from './platform.tokens';
import type { PlatformRequest } from './platform.request';

const invitationRead: readonly PlatformPermission[] = ['ADMINISTRATION', 'SUPPORT'];

const listQuerySchema = z.object({
  email: z.email().optional(),
  status: z.enum(['PENDING', 'REDEEMED', 'EXPIRED', 'REVOKED']).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
}).strict();
const issueSchema = z.object({
  email: z.string().trim().max(320).pipe(z.email()),
  betaExpiresAt: z.iso.datetime({ offset: true }),
  missionQuota: z.number().int().min(1).max(10_000),
  concurrentLimit: z.number().int().min(1).max(100),
  maxProviderSpendMinor: z.number().int().min(0).max(100_000_000),
  currency: z.string().regex(/^[A-Z]{3}$/),
  reason: z.string().trim().min(10).max(500),
}).strict();
const revokeSchema = z.object({ reason: z.string().trim().min(10).max(500) }).strict();

function principal(request: PlatformRequest): PlatformPrincipal {
  if (!request.platformPrincipal) throw new DomainError('DENIED', 'Platform session required');
  return request.platformPrincipal;
}

async function parseOrAudit<T>(
  service: PlatformRegistrationInvitationService,
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
 * MISSION A21.05 — operator management of registration invitations (invite-only signup).
 * Reads: ADMINISTRATION or SUPPORT. Issue and revoke: ADMINISTRATION only, with a written
 * justification; the service refuses self-invitations and audits every decision.
 */
@PlatformRoute()
@Controller('v1/platform/registration-invitations')
export class PlatformRegistrationInvitationsController {
  constructor(@Inject(PLATFORM_REGISTRATION_INVITATION_SERVICE) private readonly invitations: PlatformRegistrationInvitationService) {}

  @PlatformAccess(invitationRead)
  @Get()
  @Header('Cache-Control', 'private, no-store')
  async list(@Req() request: PlatformRequest, @Query() query: Record<string, unknown>): Promise<RegistrationInvitationPage> {
    const actor = principal(request);
    const parsed = await parseOrAudit(this.invitations, listQuerySchema, query, request, { action: 'LIST_REGISTRATION_INVITATIONS', targetType: 'REGISTRATION_INVITATION' });
    return this.invitations.list(actor, parsed);
  }

  @PlatformAccess('ADMINISTRATION')
  @Post()
  @Header('Cache-Control', 'private, no-store')
  async issue(@Req() request: PlatformRequest, @Body() body: unknown): Promise<RegistrationInvitationCreatedView> {
    const actor = principal(request);
    const input = await parseOrAudit(this.invitations, issueSchema, body, request, { action: 'ISSUE_REGISTRATION_INVITATION', targetType: 'REGISTRATION_INVITATION' });
    return this.invitations.issue(actor, input);
  }

  @PlatformAccess('ADMINISTRATION')
  @Post(':invitationId/revoke')
  @Header('Cache-Control', 'private, no-store')
  async revoke(@Req() request: PlatformRequest, @Param('invitationId') invitationId: string, @Body() body: unknown): Promise<RegistrationInvitationView> {
    const actor = principal(request);
    const parsedId = await parseOrAudit(this.invitations, idSchema, invitationId, request, { action: 'REVOKE_REGISTRATION_INVITATION', targetType: 'REGISTRATION_INVITATION', targetId: invitationId });
    const input = await parseOrAudit(this.invitations, revokeSchema, body, request, { action: 'REVOKE_REGISTRATION_INVITATION', targetType: 'REGISTRATION_INVITATION', targetId: parsedId });
    return this.invitations.revoke(actor, parsedId, input.reason);
  }
}

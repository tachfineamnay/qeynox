import { Body, Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { ZodError, z } from 'zod';
import { idSchema } from '@qeynox/contracts';
import { DomainError, type PlatformPermission, type PlatformPrincipal } from '@qeynox/domain';
import type {
  BetaGrantCreatedView,
  BetaGrantDetailView,
  BetaGrantPage,
  BetaGrantView,
  PlatformBetaAccessService,
  PlatformPermissionContext,
} from '@qeynox/application';
import { PlatformAccess, PlatformRoute } from '../auth/platform-route';
import { PLATFORM_BETA_ACCESS_SERVICE } from './platform.tokens';
import type { PlatformRequest } from './platform.request';

const betaRead: readonly PlatformPermission[] = ['ADMINISTRATION', 'SUPPORT'];

const listQuerySchema = z.object({
  workspaceId: idSchema.optional(),
  status: z.enum(['INVITED', 'ACTIVE', 'EXPIRED', 'REVOKED']).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
}).strict();
const grantSchema = z.object({
  workspaceId: idSchema,
  expiresAt: z.iso.datetime({ offset: true }),
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
  service: PlatformBetaAccessService,
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
 * MISSION A21.02 — operator management of invite-only beta grants.
 * Reads: ADMINISTRATION or SUPPORT. Grant and revoke: ADMINISTRATION only, with a written
 * justification; the service refuses self-grants and audits every decision.
 */
@PlatformRoute()
@Controller('v1/platform/beta-grants')
export class PlatformBetaAccessController {
  constructor(@Inject(PLATFORM_BETA_ACCESS_SERVICE) private readonly beta: PlatformBetaAccessService) {}

  @PlatformAccess(betaRead)
  @Get()
  async list(@Req() request: PlatformRequest, @Query() query: Record<string, unknown>): Promise<BetaGrantPage> {
    const actor = principal(request);
    const parsed = await parseOrAudit(this.beta, listQuerySchema, query, request, { action: 'LIST_BETA_GRANTS', targetType: 'BETA_GRANT' });
    return this.beta.list(actor, parsed);
  }

  @PlatformAccess(betaRead)
  @Get(':grantId')
  async get(@Req() request: PlatformRequest, @Param('grantId') grantId: string): Promise<BetaGrantDetailView> {
    const actor = principal(request);
    const parsedId = await parseOrAudit(this.beta, idSchema, grantId, request, { action: 'READ_BETA_GRANT', targetType: 'BETA_GRANT', targetId: grantId });
    return this.beta.get(actor, parsedId);
  }

  @PlatformAccess('ADMINISTRATION')
  @Post()
  async grant(@Req() request: PlatformRequest, @Body() body: unknown): Promise<BetaGrantCreatedView> {
    const actor = principal(request);
    const input = await parseOrAudit(this.beta, grantSchema, body, request, { action: 'GRANT_BETA_ACCESS', targetType: 'BETA_GRANT' });
    return this.beta.grant(actor, input);
  }

  @PlatformAccess('ADMINISTRATION')
  @Post(':grantId/revoke')
  async revoke(@Req() request: PlatformRequest, @Param('grantId') grantId: string, @Body() body: unknown): Promise<BetaGrantView> {
    const actor = principal(request);
    const parsedId = await parseOrAudit(this.beta, idSchema, grantId, request, { action: 'REVOKE_BETA_ACCESS', targetType: 'BETA_GRANT', targetId: grantId });
    const input = await parseOrAudit(this.beta, revokeSchema, body, request, { action: 'REVOKE_BETA_ACCESS', targetType: 'BETA_GRANT', targetId: parsedId });
    return this.beta.revoke(actor, parsedId, input.reason);
  }
}

import { Body, Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { ZodError, z } from 'zod';
import { idSchema } from '@qeynox/contracts';
import { DomainError, PLATFORM_ROLES, type PlatformPrincipal } from '@qeynox/domain';
import type {
  PlatformAdminService,
  PlatformAssignmentView,
  PlatformAuditView,
  PlatformPermissionContext,
} from '@qeynox/application';
import type { PlatformOperationRuntime, PlatformOperationSummary } from '@qeynox/persistence';
import { PlatformAccess, PlatformRoute } from '../auth/platform-route';
import { PLATFORM_ADMIN_SERVICE } from './platform.tokens';
import type { PlatformRequest } from './platform.request';

const roleSchema = z.enum(PLATFORM_ROLES);
const assignmentSchema = z.object({ role: roleSchema, reason: z.string().trim().min(5).max(500) });
const auditLimitSchema = z.number().int().min(1).max(200);

function principal(request: PlatformRequest): PlatformPrincipal {
  if (!request.platformPrincipal) throw new DomainError('DENIED', 'Platform session required');
  return request.platformPrincipal;
}

async function parseOrAudit<T>(
  platform: PlatformAdminService,
  schema: z.ZodType<T>,
  value: unknown,
  request: PlatformRequest,
  context: PlatformPermissionContext,
): Promise<T> {
  try {
    return schema.parse(value);
  } catch (error: unknown) {
    if (error instanceof ZodError) await platform.recordInputRejection(request.platformPrincipal, context);
    throw error;
  }
}

@PlatformRoute()
@Controller('v1/platform')
export class PlatformAdminController {
  constructor(@Inject(PLATFORM_ADMIN_SERVICE) private readonly platform: PlatformAdminService) {}

  /** Explicit assignment of an internal QeyNox role to an existing identity account. */
  @PlatformAccess('ADMINISTRATION')
  @Post('admins/:userId/assign')
  async assign(@Req() request: PlatformRequest, @Param('userId') userId: string, @Body() body: unknown): Promise<PlatformAssignmentView> {
    const actor = principal(request);
    const targetUserId = await parseOrAudit(this.platform, idSchema, userId, request, { action: 'ASSIGN_PLATFORM_ROLE', targetType: 'PLATFORM_ASSIGNMENT', targetId: userId });
    const input = await parseOrAudit(this.platform, assignmentSchema, body, request, { action: 'ASSIGN_PLATFORM_ROLE', targetType: 'PLATFORM_ASSIGNMENT', targetId: targetUserId });
    return this.platform.assign({ actor, targetUserId, role: input.role, reason: input.reason });
  }

  @PlatformAccess('ADMINISTRATION')
  @Post('admins/:userId/revoke')
  async revoke(@Req() request: PlatformRequest, @Param('userId') userId: string, @Body() body: unknown): Promise<PlatformAssignmentView> {
    const actor = principal(request);
    const targetUserId = await parseOrAudit(this.platform, idSchema, userId, request, { action: 'REVOKE_PLATFORM_ROLE', targetType: 'PLATFORM_ASSIGNMENT', targetId: userId });
    const input = await parseOrAudit(this.platform, assignmentSchema, body, request, { action: 'REVOKE_PLATFORM_ROLE', targetType: 'PLATFORM_ASSIGNMENT', targetId: targetUserId });
    return this.platform.revoke({ actor, targetUserId, role: input.role, reason: input.reason });
  }

  @PlatformAccess('CONSULTATION')
  @Get('admins')
  listAdmins(@Req() request: PlatformRequest): Promise<readonly PlatformAssignmentView[]> {
    return this.platform.listAssignments(principal(request));
  }

  @PlatformAccess('CONSULTATION')
  @Get('audit')
  async audit(@Req() request: PlatformRequest, @Query('limit') limit?: string): Promise<readonly PlatformAuditView[]> {
    const actor = principal(request);
    const parsed = limit === undefined
      ? undefined
      : await parseOrAudit(this.platform, auditLimitSchema, Number(limit), request, { action: 'LIST_PLATFORM_AUDIT', targetType: 'PLATFORM_AUDIT' });
    return this.platform.listAudit(actor, parsed);
  }

  /** Read-only customer-support diagnostics across workspaces (no mutation, no secret). */
  @PlatformAccess('SUPPORT')
  @Get('support/operations/:operationId')
  async readSupportOperation(@Req() request: PlatformRequest, @Param('operationId') operationId: string): Promise<PlatformOperationSummary> {
    const actor = principal(request);
    const parsedId = await parseOrAudit(this.platform, idSchema, operationId, request, { action: 'READ_PLATFORM_OPERATION_SUMMARY', targetType: 'OPERATION', targetId: operationId });
    return this.platform.readSupportOperation(actor, parsedId);
  }

  /** Read-only technical-operations inspection. Never cancels, retries or replays work. */
  @PlatformAccess('OPERATIONS')
  @Get('operations/:operationId/runtime')
  async readOperationRuntime(@Req() request: PlatformRequest, @Param('operationId') operationId: string): Promise<PlatformOperationRuntime> {
    const actor = principal(request);
    const parsedId = await parseOrAudit(this.platform, idSchema, operationId, request, { action: 'READ_PLATFORM_OPERATION_RUNTIME', targetType: 'OPERATION', targetId: operationId });
    return this.platform.readOperationRuntime(actor, parsedId);
  }
}

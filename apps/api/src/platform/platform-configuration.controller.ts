import { Body, Controller, Get, Inject, Post, Query, Req } from '@nestjs/common';
import { ZodError, z } from 'zod';
import { platformConfigurationApplySchema, platformConfigurationQuerySchema, serviceValidationRequestSchema } from '@qeynox/contracts';
import { DomainError, type PlatformPrincipal } from '@qeynox/domain';
import type {
  PlatformConfigurationService,
  PlatformPermissionContext,
} from '@qeynox/application';
import { PlatformAccess, PlatformRoute } from '../auth/platform-route';
import { PLATFORM_CONFIGURATION_SERVICE } from './platform.tokens';
import type { PlatformRequest } from './platform.request';

function principal(request: PlatformRequest): PlatformPrincipal {
  if (!request.platformPrincipal) throw new DomainError('DENIED', 'Platform session required');
  return request.platformPrincipal;
}

async function parseOrAudit<T>(
  service: PlatformConfigurationService,
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
 * Platform-side operator configuration for the Control console.
 *
 * Reads require CONSULTATION; previews (dry-run) and applications require ADMINISTRATION. Both
 * additionally pass the operator engine's own gates (QEYNOX_OPERATOR_USER_IDS and an ACTIVE
 * OWNER/ADMIN/OPERATOR membership in the target workspace), so a platform session never becomes a
 * workspace session. Every call carries an explicit workspaceId, previews and applications carry a
 * mandatory written justification, and every success and denial lands in the append-only platform
 * audit trail — the apply audit row commits inside the same transaction as the configuration
 * mutation. When the operator allowlist is unset every route fails closed with NOT_CONFIGURED.
 */
@PlatformRoute()
@Controller('v1/platform/configuration')
export class PlatformConfigurationController {
  constructor(@Inject(PLATFORM_CONFIGURATION_SERVICE) private readonly configuration: PlatformConfigurationService) {}

  /** Configuration state for the chosen workspace: slots, profiles, tools, policies, offers (incl. tax) and budgets. */
  @PlatformAccess('CONSULTATION')
  @Get()
  async state(@Req() request: PlatformRequest, @Query() query: Record<string, unknown>) {
    const actor = principal(request);
    const parsed = await parseOrAudit(this.configuration, platformConfigurationQuerySchema, query, request, {
      action: 'READ_PLATFORM_CONFIGURATION', targetType: 'PLATFORM_CONFIGURATION', targetId: typeof query?.workspaceId === 'string' ? query.workspaceId : null,
    });
    return this.configuration.state(actor, parsed.workspaceId);
  }

  /** Dry-run: identical validation and outcome computation; persists nothing except the audit row. */
  @PlatformAccess('ADMINISTRATION')
  @Post('preview')
  async preview(@Req() request: PlatformRequest, @Body() body: unknown) {
    const actor = principal(request);
    const input = await parseOrAudit(this.configuration, platformConfigurationApplySchema, body, request, {
      action: 'PREVIEW_PLATFORM_CONFIGURATION', targetType: 'PLATFORM_CONFIGURATION', targetId: (body as { workspaceId?: string })?.workspaceId ?? null,
    });
    return this.configuration.preview(actor, input);
  }

  /** Read-only validation of one service definition against the live configuration. Never mutates. */
  @PlatformAccess('CONSULTATION')
  @Post('validate-service')
  async validateService(@Req() request: PlatformRequest, @Body() body: unknown) {
    const actor = principal(request);
    const input = await parseOrAudit(this.configuration, serviceValidationRequestSchema, body, request, {
      action: 'READ_PLATFORM_SERVICE_VALIDATION', targetType: 'PLATFORM_CONFIGURATION', targetId: (body as { workspaceId?: string })?.workspaceId ?? null,
    });
    return this.configuration.validateService(actor, input);
  }

  /** Apply the configuration bundle. Idempotency-key guarded; audit row commits with the mutation. */
  @PlatformAccess('ADMINISTRATION')
  @Post('apply')
  async apply(@Req() request: PlatformRequest, @Body() body: unknown) {
    const actor = principal(request);
    const input = await parseOrAudit(this.configuration, platformConfigurationApplySchema, body, request, {
      action: 'APPLY_PLATFORM_CONFIGURATION', targetType: 'PLATFORM_CONFIGURATION', targetId: (body as { workspaceId?: string })?.workspaceId ?? null,
    });
    return this.configuration.apply(actor, input);
  }
}

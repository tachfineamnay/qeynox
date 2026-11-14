import { Controller, Get, Inject, Param, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { idSchema } from '@qeynox/contracts';
import { DomainError, type PlatformPrincipal } from '@qeynox/domain';
import type { PlatformOperationsService } from '@qeynox/application';
import { PlatformAccess, PlatformRoute } from '../auth/platform-route';
import { PLATFORM_OPERATIONS_SERVICE } from './platform.tokens';
import type { PlatformRequest } from './platform.request';

const listSchema = z.object({
  status: z.string().trim().min(1).max(40).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

function principal(request: PlatformRequest): PlatformPrincipal {
  if (!request.platformPrincipal) throw new DomainError('DENIED', 'Platform session required');
  return request.platformPrincipal;
}

/**
 * Read-only operations desk API, restricted by the existing OPERATIONS permission.
 * There is deliberately no mutation route: no cancel, retry, replay, redeploy or Docker command.
 */
@PlatformRoute()
@Controller('v1/platform/operations')
export class PlatformOperationsController {
  constructor(@Inject(PLATFORM_OPERATIONS_SERVICE) private readonly operations: PlatformOperationsService) {}

  @PlatformAccess('OPERATIONS')
  @Get()
  list(@Req() request: PlatformRequest, @Query() query: unknown) {
    const input = listSchema.parse(query ?? {});
    return this.operations.list(principal(request), { status: input.status, limit: input.limit });
  }

  @PlatformAccess('OPERATIONS')
  @Get('summary')
  summary(@Req() request: PlatformRequest) { return this.operations.list(principal(request), {}); }

  @PlatformAccess('OPERATIONS')
  @Get('incidents')
  incidents(@Req() request: PlatformRequest, @Query('limit') limit?: string) {
    const parsed = limit === undefined ? 50 : Math.min(Math.max(Number(limit) || 50, 1), 100);
    return this.operations.incidents(principal(request), parsed);
  }

  @PlatformAccess('OPERATIONS')
  @Get('health')
  health(@Req() request: PlatformRequest) { return this.operations.health(principal(request)); }

  @PlatformAccess('OPERATIONS')
  @Get('releases')
  releases(@Req() request: PlatformRequest) { return this.operations.releases(principal(request)); }

  @PlatformAccess('OPERATIONS')
  @Get('resources')
  resources(@Req() request: PlatformRequest) { return this.operations.resources(principal(request)); }

  @PlatformAccess('OPERATIONS')
  @Get(':operationId')
  detail(@Req() request: PlatformRequest, @Param('operationId') operationId: string) {
    return this.operations.detail(principal(request), idSchema.parse(operationId));
  }
}

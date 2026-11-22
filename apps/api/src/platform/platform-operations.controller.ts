import { Body, Controller, Get, Header, Post, Inject, Param, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { idSchema } from '@qeynox/contracts';
import { DomainError, type PlatformPrincipal } from '@qeynox/domain';
import type { PlatformOperationsService, PlatformBetaOperationsService } from '@qeynox/application';
import { PlatformAccess, PlatformRoute } from '../auth/platform-route';
import { apiRuntimeReadiness } from '../operations/runtime-readiness';
import { PLATFORM_OPERATIONS_SERVICE, PLATFORM_BETA_OPERATIONS_SERVICE } from './platform.tokens';
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
 * Existing operations desk, restricted by OPERATIONS. P20 adds two narrowly audited local recovery
 * actions; no replay, force-completion, external runtime command or deployment route.
 */
@PlatformRoute()
@Controller('v1/platform/operations')
export class PlatformOperationsController {
  constructor(@Inject(PLATFORM_OPERATIONS_SERVICE) private readonly operations: PlatformOperationsService, @Inject(PLATFORM_BETA_OPERATIONS_SERVICE) private readonly beta: PlatformBetaOperationsService) {}

  @PlatformAccess('OPERATIONS')
  @Get()
  @Header('Cache-Control', 'private, no-store')
  list(@Req() request: PlatformRequest, @Query() query: unknown) {
    const input = listSchema.parse(query ?? {});
    return this.operations.list(principal(request), { status: input.status, limit: input.limit });
  }

  @PlatformAccess('OPERATIONS')
  @Get('summary')
  @Header('Cache-Control', 'private, no-store')
  summary(@Req() request: PlatformRequest) { return this.operations.list(principal(request), {}); }

  @PlatformAccess('OPERATIONS')
  @Get('incidents')
  @Header('Cache-Control', 'private, no-store')
  incidents(@Req() request: PlatformRequest, @Query('limit') limit?: string) {
    const parsed = limit === undefined ? 50 : Math.min(Math.max(Number(limit) || 50, 1), 100);
    return this.operations.incidents(principal(request), parsed);
  }

  @PlatformAccess('OPERATIONS')
  @Get('health')
  @Header('Cache-Control', 'private, no-store')
  health(@Req() request: PlatformRequest) { return this.operations.health(principal(request)); }

  @PlatformAccess('OPERATIONS')
  @Get('releases')
  @Header('Cache-Control', 'private, no-store')
  releases(@Req() request: PlatformRequest) { return this.operations.releases(principal(request)); }

  @PlatformAccess('OPERATIONS')
  @Get('resources')
  @Header('Cache-Control', 'private, no-store')
  resources(@Req() request: PlatformRequest) { return this.operations.resources(principal(request)); }

  @PlatformAccess('OPERATIONS')
  @Get('queues')
  @Header('Cache-Control', 'private, no-store')
  queues(@Req() request: PlatformRequest, @Query() query: unknown) { return this.beta.queues(principal(request), query); }

  @PlatformAccess('OPERATIONS')
  @Get('spending')
  @Header('Cache-Control', 'private, no-store')
  spending(@Req() request: PlatformRequest, @Query() query: unknown) { return this.beta.spending(principal(request), query); }

  @PlatformAccess('OPERATIONS')
  @Get('runtime')
  @Header('Cache-Control', 'private, no-store')
  runtime(@Req() request: PlatformRequest) { return this.beta.runtime(principal(request), apiRuntimeReadiness()); }

  @PlatformAccess('OPERATIONS')
  @Get('migrations')
  @Header('Cache-Control', 'private, no-store')
  migrations(@Req() request: PlatformRequest) { return this.beta.migrations(principal(request)); }

  @PlatformAccess('OPERATIONS')
  @Post('recovery')
  @Header('Cache-Control', 'private, no-store')
  recover(@Req() request: PlatformRequest, @Body() body: unknown) { return this.beta.recover(principal(request), body); }

  @PlatformAccess('OPERATIONS')
  @Get(':operationId')
  @Header('Cache-Control', 'private, no-store')
  detail(@Req() request: PlatformRequest, @Param('operationId') operationId: string) {
    return this.operations.detail(principal(request), idSchema.parse(operationId));
  }
}

import { Body, Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { ZodError, z } from 'zod';
import { DomainError, type PlatformPrincipal } from '@qeynox/domain';
import type { PlatformSupportService, PlatformPermissionContext } from '@qeynox/application';
import { PlatformAccess, PlatformRoute } from '../auth/platform-route';
import { PLATFORM_SUPPORT_SERVICE } from './support.tokens';
import type { PlatformRequest } from '../platform/platform.request';

const statusSchema = z.enum(['open', 'pending', 'resolved', 'snoozed', 'all']);
const reasonSchema = z.string().trim().min(10).max(500);
const requestIdSchema = z.string().trim().min(8).max(200).optional();
const pageSchema = z.coerce.number().int().min(1).max(100);
const replySchema = z.object({ content: z.string().trim().min(2).max(5000), reason: reasonSchema, requestId: requestIdSchema });
const updateSchema = z.object({ status: z.enum(['open', 'pending', 'resolved']), reason: reasonSchema });
const listSchema = z.object({ status: statusSchema.optional(), page: pageSchema.optional() });

function principal(request: PlatformRequest): PlatformPrincipal {
  if (!request.platformPrincipal) throw new DomainError('DENIED', 'Platform session required');
  return request.platformPrincipal;
}

async function parseOrAudit<T>(
  service: PlatformSupportService,
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
 * Platform support center, restricted by the existing SUPPORT permission.
 *
 * It exposes the live Chatwoot inbox (status, priority, history) and reply/status actions. Every
 * mutation requires a justification and is audited; schema-rejected input is audited too. Retries
 * carrying the same `requestId` are deduplicated. No support message is copied into PostgreSQL, and
 * the Chatwoot API token stays on the server. Private notes are visible here (operator surface) and
 * never on the customer surface.
 */
@PlatformRoute()
@Controller('v1/platform/support')
export class PlatformSupportController {
  constructor(@Inject(PLATFORM_SUPPORT_SERVICE) private readonly support: PlatformSupportService) {}

  @PlatformAccess('SUPPORT')
  @Get('status')
  status(@Req() request: PlatformRequest) { return this.support.status(principal(request)); }

  @PlatformAccess('SUPPORT')
  @Get('conversations')
  async list(@Req() request: PlatformRequest, @Query('status') status?: string, @Query('page') page?: string) {
    const parsed = await parseOrAudit(
      this.support, listSchema,
      { status: status === undefined || status.length === 0 ? undefined : status, page: page === undefined || page.length === 0 ? undefined : page },
      request, { action: 'LIST_SUPPORT_CONVERSATIONS', targetType: 'SUPPORT_CENTER' },
    );
    return this.support.list(principal(request), parsed);
  }

  @PlatformAccess('SUPPORT')
  @Get('conversations/:id')
  get(@Req() request: PlatformRequest, @Param('id') id: string) { return this.support.get(principal(request), id); }

  @PlatformAccess('SUPPORT')
  @Post('conversations/:id/messages')
  async reply(@Req() request: PlatformRequest, @Param('id') id: string, @Body() body: unknown) {
    const input = await parseOrAudit(this.support, replySchema, body, request, { action: 'REPLY_SUPPORT_CONVERSATION', targetType: 'SUPPORT_CONVERSATION', targetId: id });
    return this.support.reply(principal(request), id, input.content, { reason: input.reason, requestId: input.requestId });
  }

  @PlatformAccess('SUPPORT')
  @Post('conversations/:id/status')
  async updateStatus(@Req() request: PlatformRequest, @Param('id') id: string, @Body() body: unknown) {
    const input = await parseOrAudit(this.support, updateSchema, body, request, { action: 'UPDATE_SUPPORT_STATUS', targetType: 'SUPPORT_CONVERSATION', targetId: id });
    return this.support.updateStatus(principal(request), id, input.status, { reason: input.reason });
  }
}

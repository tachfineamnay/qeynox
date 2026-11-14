import { Body, Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { DomainError, type PlatformPrincipal } from '@qeynox/domain';
import type { PlatformSupportService } from '@qeynox/application';
import { PlatformAccess, PlatformRoute } from '../auth/platform-route';
import { PLATFORM_SUPPORT_SERVICE } from './support.tokens';
import type { PlatformRequest } from '../platform/platform.request';

const statusSchema = z.enum(['open', 'pending', 'resolved', 'snoozed', 'all']);
const replySchema = z.object({ content: z.string().trim().min(2).max(5000) });
const updateSchema = z.object({ status: z.enum(['open', 'pending', 'resolved']) });

function principal(request: PlatformRequest): PlatformPrincipal {
  if (!request.platformPrincipal) throw new DomainError('DENIED', 'Platform session required');
  return request.platformPrincipal;
}

/**
 * Platform support center, restricted by the existing SUPPORT permission.
 *
 * It exposes the live Chatwoot inbox (status, priority, history) and reply/status actions. Every
 * mutation is audited. No support message is copied into PostgreSQL, and the Chatwoot API token
 * stays on the server.
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
  list(@Req() request: PlatformRequest, @Query('status') status?: string) {
    const parsed = status === undefined || status.length === 0 ? undefined : statusSchema.parse(status);
    return this.support.list(principal(request), { status: parsed });
  }

  @PlatformAccess('SUPPORT')
  @Get('conversations/:id')
  get(@Req() request: PlatformRequest, @Param('id') id: string) { return this.support.get(principal(request), id); }

  @PlatformAccess('SUPPORT')
  @Post('conversations/:id/messages')
  reply(@Req() request: PlatformRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.support.reply(principal(request), id, replySchema.parse(body).content);
  }

  @PlatformAccess('SUPPORT')
  @Post('conversations/:id/status')
  updateStatus(@Req() request: PlatformRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.support.updateStatus(principal(request), id, updateSchema.parse(body).status);
  }
}

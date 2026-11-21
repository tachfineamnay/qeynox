import { Body, Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { idSchema } from '@qeynox/contracts';
import { DomainError, type Principal } from '@qeynox/domain';
import type { NotificationService } from '@qeynox/application';
import { NOTIFICATIONS } from './notifications.tokens';

interface AuthedRequest { principal?: Principal }

function principal(request: AuthedRequest): Principal {
  if (!request.principal) throw new DomainError('DENIED', 'Authenticated session required');
  return request.principal;
}

const listSchema = z.object({
  unreadOnly: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().trim().min(8).max(512).optional(),
}).strict();

const preferenceSchema = z.object({
  category: z.enum(['APPROVALS', 'EXECUTION_FAILURES', 'RESULTS']),
  emailEnabled: z.boolean(),
}).strict();

/**
 * MISSION A19 — in-app notification inbox for the signed-in workspace member.
 *
 * Items are scoped to (user, current workspace): switching workspaces switches the inbox, in line
 * with every other tenant-scoped surface in this API. Preferences are per user, per category, and
 * govern e-mail only — in-app rows are always recorded; transactional e-mails are never gated.
 */
@Controller('v1/notifications')
export class NotificationsController {
  constructor(@Inject(NOTIFICATIONS) private readonly notifications: NotificationService) {}

  @Get()
  list(@Req() request: AuthedRequest, @Query() query: unknown) {
    const input = listSchema.parse(query ?? {});
    const actor = principal(request);
    return this.notifications.inbox(actor.userId, actor.workspaceId, {
      unreadOnly: input.unreadOnly === 'true',
      limit: input.limit,
      cursor: input.cursor ?? null,
    });
  }

  @Get('preferences')
  preferences(@Req() request: AuthedRequest) {
    return this.notifications.preferences(principal(request).userId);
  }

  @Post('preferences')
  setPreference(@Req() request: AuthedRequest, @Body() body: unknown) {
    const input = preferenceSchema.parse(body ?? {});
    return this.notifications.setPreference(principal(request).userId, input.category, input.emailEnabled);
  }

  @Post('read-all')
  readAll(@Req() request: AuthedRequest) {
    const actor = principal(request);
    return this.notifications.markAllRead(actor.userId, actor.workspaceId);
  }

  @Post(':notificationId/read')
  read(@Req() request: AuthedRequest, @Param('notificationId') notificationId: string) {
    const actor = principal(request);
    return this.notifications.markRead(actor.userId, actor.workspaceId, idSchema.parse(notificationId));
  }
}

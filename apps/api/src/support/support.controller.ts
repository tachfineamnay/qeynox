import { Body, Controller, Get, Inject, Param, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { DomainError, type Principal } from '@qeynox/domain';
import type { SupportService } from '@qeynox/application';
import { SUPPORT_SERVICE } from './support.tokens';

interface Request { principal?: Principal }

const openSchema = z.object({ message: z.string().trim().min(2).max(5000) });
const replySchema = z.object({ content: z.string().trim().min(2).max(5000) });

function principal(request: Request): Principal {
  if (!request.principal?.workspaceId || !request.principal.userId) throw new DomainError('DENIED', 'Authenticated workspace required');
  return request.principal;
}

/**
 * Customer support endpoints. Chatwoot is only reached server-side; no token or webhook secret is
 * returned. Conversations are scoped by the authenticated user AND active workspace through the
 * support_chatwoot_links mapping, so a workspace session can never read another user's inbox.
 */
@Controller('v1/support')
export class SupportController {
  constructor(@Inject(SUPPORT_SERVICE) private readonly support: SupportService) {}

  @Get('status')
  status() { return this.support.capability(); }

  @Get('conversations')
  list(@Req() request: Request) { return this.support.listMine(principal(request)); }

  @Post('conversations')
  open(@Req() request: Request, @Body() body: unknown) {
    return this.support.open(principal(request), openSchema.parse(body).message);
  }

  @Get('conversations/:id')
  get(@Req() request: Request, @Param('id') id: string) { return this.support.get(principal(request), id); }

  @Post('conversations/:id/messages')
  reply(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.support.reply(principal(request), id, replySchema.parse(body).content);
  }
}

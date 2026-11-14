import { Body, Controller, Delete, Get, Inject, Param, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { DomainError, requireId, type Principal } from '@qeynox/domain';
import { SoulService } from '@qeynox/roles';
import { SOUL_SERVICE } from './soul.tokens';
interface Request { principal?: Principal }
const consentSchema = z.object({
  purpose: z.string().trim().min(3).max(200),
  scopes: z.array(z.string().trim().min(2).max(120)).min(1).max(50),
  expiresAt: z.string().optional(),
});
const factSchema = z.object({ key: z.string().trim().min(1).max(80), value: z.unknown(), consentId: z.string().min(4) });
const converseSchema = z.object({ message: z.string().min(1).max(5000), operationId: z.string().min(4), attemptId: z.string().min(4) });
function principal(request: Request): Principal {
  if (!request.principal?.workspaceId || !request.principal.userId) throw new DomainError('DENIED', 'Authenticated workspace required');
  return request.principal;
}
/** User-controlled consented context. Every read/write is checked against an explicit consent. */
@Controller('v1/soul')
export class SoulController {
  constructor(@Inject(SOUL_SERVICE) private readonly soul: SoulService) {}
  @Get('context')
  context(@Req() request: Request) { return this.soul.viewContext(principal(request)); }
  @Get('consents')
  consents(@Req() request: Request) { return this.soul.listConsents(principal(request)); }
  @Post('consents')
  grant(@Req() request: Request, @Body() body: unknown) {
    const input = consentSchema.parse(body);
    return this.soul.grantConsent(principal(request), input.purpose, input.scopes, input.expiresAt);
  }
  @Post('consents/:id/revoke')
  async revoke(@Req() request: Request, @Param('id') id: string) {
    await this.soul.revokeConsent(principal(request), requireId(id));
    return { revoked: true };
  }
  @Delete('context')
  async deleteAllContext(@Req() request: Request) {
    return this.soul.deleteAllContext(principal(request));
  }
  @Post('context/facts')
  saveFact(@Req() request: Request, @Body() body: unknown) {
    const input = factSchema.parse(body);
    return this.soul.saveFact(principal(request), input.key, input.value, requireId(input.consentId));
  }
  @Delete('context/facts/:id')
  async deleteFact(@Req() request: Request, @Param('id') id: string) {
    await this.soul.deleteFact(principal(request), requireId(id));
    return { deleted: true };
  }
  @Post('converse')
  converse(@Req() request: Request, @Body() body: unknown) {
    const input = converseSchema.parse(body);
    return this.soul.converse(principal(request), input.message, requireId(input.operationId), requireId(input.attemptId));
  }
}


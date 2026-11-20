import { Body, Controller, Delete, Get, Headers, Inject, Param, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { idSchema } from '@qeynox/contracts';
import { DomainError, type Principal } from '@qeynox/domain';
import type { AccountSettingsService } from '@qeynox/application';
import { hashSessionToken } from '../auth/password';
import { ACCOUNT_SETTINGS } from './account.tokens';

interface AuthedRequest { principal?: Principal }

function principal(request: AuthedRequest): Principal {
  if (!request.principal) throw new DomainError('DENIED', 'Authenticated session required');
  return request.principal;
}

/** SHA-256 of the presented bearer token — used only to mark the current session, never stored. */
function currentTokenHash(authorization: string | undefined): string {
  const raw = typeof authorization === 'string' && authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (raw.length < 32 || raw.length > 256) throw new DomainError('DENIED', 'Session missing');
  return hashSessionToken(raw);
}

const localeSchema = z.object({ locale: z.string().trim().min(2).max(12) }).strict();
const passwordSchema = z.object({ currentPassword: z.string().min(1).max(256), nextPassword: z.string().min(12).max(256) }).strict();
const deletionSchema = z.object({ reason: z.string().trim().max(500).optional() }).strict();

/**
 * MISSION A18 — customer self-service account, security and privacy endpoints.
 *
 * Sessions listed here are `identity_sessions` rows of the authenticated account only; platform
 * administration sessions live in a separate namespace and are unreachable from this surface.
 * Deletion requests are recorded intent, never erasure.
 */
@Controller('v1/account')
export class AccountController {
  constructor(@Inject(ACCOUNT_SETTINGS) private readonly account: AccountSettingsService) {}

  @Get('profile')
  profile(@Req() request: AuthedRequest) {
    return this.account.profile(principal(request));
  }

  @Post('profile')
  updateProfile(@Req() request: AuthedRequest, @Body() body: unknown) {
    const input = localeSchema.parse(body);
    return this.account.updateProfile(principal(request), input);
  }

  @Get('sessions')
  sessions(@Req() request: AuthedRequest, @Headers('authorization') authorization: string) {
    return this.account.sessions(principal(request), currentTokenHash(authorization));
  }

  @Post('sessions/revoke-others')
  revokeOtherSessions(@Req() request: AuthedRequest, @Headers('authorization') authorization: string) {
    return this.account.revokeOtherSessions(principal(request), currentTokenHash(authorization));
  }

  @Post('sessions/:sessionId/revoke')
  revokeSession(@Req() request: AuthedRequest, @Param('sessionId') sessionId: string, @Headers('authorization') authorization: string) {
    return this.account.revokeSession(principal(request), idSchema.parse(sessionId), currentTokenHash(authorization));
  }

  @Post('password')
  changePassword(@Req() request: AuthedRequest, @Body() body: unknown, @Headers('authorization') authorization: string) {
    const input = passwordSchema.parse(body);
    return this.account.changePassword(principal(request), input, currentTokenHash(authorization));
  }

  @Get('deletion-request')
  deletionStatus(@Req() request: AuthedRequest) {
    return this.account.deletionStatus(principal(request));
  }

  @Post('deletion-request')
  requestDeletion(@Req() request: AuthedRequest, @Body() body: unknown) {
    const input = deletionSchema.parse(body ?? {});
    return this.account.requestDeletion(principal(request), input);
  }

  @Post('deletion-request/cancel')
  cancelDeletion(@Req() request: AuthedRequest) {
    return this.account.cancelDeletion(principal(request));
  }
}

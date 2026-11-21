import { Body, Controller, Get, HttpCode, Inject, Post, Query, Req } from '@nestjs/common';
import { DomainError, type Principal } from '@qeynox/domain';
import type { TokenRequestOutcome, VerificationResendResult } from '@qeynox/application';
import { PublicRoute } from './public-route';
import { IdentityLifecycleApiService } from './identity-lifecycle.service';

interface ReqType { principal?: Principal }

/**
 * Customer identity lifecycle: verification and account recovery.
 *
 * Route placement matters. The token-consuming routes are public because a customer who cannot sign
 * in is exactly the person who must use them; they authorize by possession of a single-use token,
 * never by a session. `/state` requires a session because it describes the caller's own account.
 *
 * Every response distinguishes "a message was delivered" from "a token was issued but nothing was
 * sent". With no transport configured the second is the only truthful answer, and it is never
 * upgraded to the first.
 */
@Controller('v1/identity')
export class IdentityController {
  constructor(@Inject(IdentityLifecycleApiService) private readonly lifecycle: IdentityLifecycleApiService) {}

  /** Verification/verification-delivery state of the authenticated account. */
  @Get('state')
  async state(@Req() request: ReqType) {
    return this.lifecycle.state(principal(request).userId);
  }

  /** Ask for a verification link. Throttled; the reply never reveals whether the address exists. */
  @PublicRoute()
  @Post('verification/request')
  requestVerification(@Body() body: unknown): Promise<TokenRequestOutcome> {
    return this.lifecycle.requestVerification(body);
  }

  /**
   * MISSION A21.06 — resend the verification link to the signed-in account's OWN address. Requires a
   * session (no @PublicRoute). The body is deliberately not bound: the recipient comes from the
   * session identity only. Outcomes: ACCEPTED | NOT_CONFIGURED | DELIVERY_FAILED | ALREADY_VERIFIED;
   * throttling is 429 BUDGET_EXHAUSTED.
   */
  @Post('verification/resend')
  @HttpCode(200)
  resendVerification(@Req() request: ReqType): Promise<VerificationResendResult> {
    return this.lifecycle.resendVerification(principal(request).userId);
  }

  /** Pre-flight for the verification landing page; does not consume the token. */
  @PublicRoute()
  @Get('verification/inspect')
  inspectVerification(@Query() query: unknown): Promise<{ valid: boolean }> {
    return this.lifecycle.inspectVerification(query);
  }

  /** Consume a verification token. Public: possession of the token is the authorization. */
  @PublicRoute()
  @Post('verification/confirm')
  confirmVerification(@Body() body: unknown): Promise<{ verified: true; userId: string }> {
    return this.lifecycle.confirmVerification(body);
  }

  /** Ask for a recovery link. Same anti-enumeration contract as verification. */
  @PublicRoute()
  @Post('recovery/request')
  requestRecovery(@Body() body: unknown): Promise<TokenRequestOutcome> {
    return this.lifecycle.requestReset(body);
  }

  /** Pre-flight for the "choose a new password" screen; does not consume the token. */
  @PublicRoute()
  @Get('recovery/inspect')
  inspectRecovery(@Query() query: unknown): Promise<{ valid: boolean }> {
    return this.lifecycle.inspectReset(query);
  }

  /** Complete recovery: consumes the token, rewrites the credential and revokes every session. */
  @PublicRoute()
  @Post('recovery/confirm')
  confirmRecovery(@Body() body: unknown): Promise<{ reset: true; revokedSessions: number }> {
    return this.lifecycle.confirmReset(body);
  }
}

function principal(request: ReqType): Principal {
  if (!request.principal) throw new DomainError('DENIED', 'Authenticated session required');
  return request.principal;
}

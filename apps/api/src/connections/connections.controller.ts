import { Controller, Get, Inject, Param, Post, Query, Req, Res, HttpStatus } from '@nestjs/common';
import { z } from 'zod';
import { DomainError, type Principal } from '@qeynox/domain';
import { ConnectionHubService } from '@qeynox/application';
import { CONNECTIONS_HUB } from './connections.tokens';
import { PublicRoute } from '../auth/public-route';

/** Structural view of the express response so this module needs no express type dependency. */
interface RedirectResponse {
  status(code: number): { type(mime: string): { send(body: string): void } };
  redirect(status: number, url: string): void;
}

interface Request { principal?: Principal }
const providerIdSchema = z.string().min(2).max(64).regex(/^[a-z0-9-]+$/);
const stateSchema = z.string().min(16).max(256).regex(/^[A-Za-z0-9_-]+$/);
const codeSchema = z.string().min(1).max(2048);

function principal(request: Request): Principal {
  if (!request.principal) throw new DomainError('DENIED', 'Session required');
  return request.principal;
}

/**
 * MISSION A14 — connector hub HTTP surface.
 *
 * GET    /v1/connections                      — workspace-scoped provider states (never credentials)
 * GET    /v1/connections/audit                — workspace audit trail, latest first
 * POST   /v1/connections/:provider/authorize  — start OAuth (returns the authorization URL)
 * GET    /v1/connections/:provider/callback   — provider redirect landing (state-verified, no session)
 * POST   /v1/connections/:provider/disconnect — revoke + local wipe (OWNER/ADMIN or the connector)
 * POST   /v1/connections/:provider/refresh    — manual token refresh/repair (same permission rule)
 *
 * No endpoint ever returns token material, client secrets or credential references.
 */
@Controller('v1/connections')
export class ConnectionsController {
  constructor(@Inject(CONNECTIONS_HUB) private readonly hub: ConnectionHubService) {}

  @Get()
  list(@Req() request: Request) {
    return this.hub.list(principal(request));
  }

  @Get('audit')
  audit(@Req() request: Request, @Query('limit') limit?: string) {
    const parsed = limit === undefined ? 50 : Number.parseInt(String(limit), 10);
    return this.hub.audit(principal(request), Number.isFinite(parsed) ? parsed : 50);
  }

  @Post(':provider/authorize')
  authorize(@Req() request: Request, @Param('provider') provider: string) {
    return this.hub.authorize(principal(request), providerIdSchema.parse(provider));
  }

  /**
   * OAuth redirect landing. Unauthenticated by design (the provider cannot present our bearer);
   * the state hash authenticates the round-trip and is single-use. On completion the browser is
   * redirected to the configured public Web base; no token is ever in the URL.
   */
  @Get(':provider/callback')
  @PublicRoute()
  async callback(@Param('provider') provider: string, @Query('code') code?: string, @Query('state') state?: string, @Query('error') error?: string, @Res() response?: RedirectResponse) {
    if (!response) throw new DomainError('UNEXPECTED_EXECUTION_ERROR', 'response object required');
    const base = (process.env.QEYNOX_PUBLIC_URL ?? '').replace(/\/+$/, '');
    const lang = 'en';
    const fail = (reason: string) => {
      if (!base) {
        response.status(HttpStatus.BAD_REQUEST).type('text/plain').send('Connection failed: ' + reason + '. You can close this window.');
        return;
      }
      response.redirect(302, base + '/' + lang + '/connections?error=' + encodeURIComponent(reason));
    };
    if (error) { fail('PROVIDER_DENIED'); return; }
    const parsedProvider = providerIdSchema.safeParse(provider);
    const parsedCode = codeSchema.safeParse(code ?? '');
    const parsedState = stateSchema.safeParse(state ?? '');
    if (!parsedProvider.success || !parsedCode.success || !parsedState.success) { fail('INVALID_INPUT'); return; }
    try {
      const result = await this.hub.callback({ providerId: parsedProvider.data, code: parsedCode.data, state: parsedState.data });
      if (!base) {
        response.status(HttpStatus.OK).type('text/plain').send('Connected (' + result.provider + '): ' + result.state + '. You can close this window.');
        return;
      }
      response.redirect(302, base + '/' + lang + '/connections?connected=' + encodeURIComponent(result.provider));
    } catch (error: unknown) {
      fail(error instanceof DomainError ? error.code : 'UNAVAILABLE');
    }
  }

  @Post(':provider/disconnect')
  disconnect(@Req() request: Request, @Param('provider') provider: string) {
    return this.hub.disconnect(principal(request), providerIdSchema.parse(provider));
  }

  @Post(':provider/refresh')
  refresh(@Req() request: Request, @Param('provider') provider: string) {
    return this.hub.refresh(principal(request), providerIdSchema.parse(provider));
  }
}

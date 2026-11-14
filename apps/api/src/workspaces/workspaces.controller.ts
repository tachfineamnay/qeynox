import { Body, Controller, Get, Inject, Param, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { idSchema } from '@qeynox/contracts';
import { DomainError, type Principal } from '@qeynox/domain';
import type { InvitationResponseView, WorkspaceAccessService, WorkspaceInvitationView } from '@qeynox/application';
import { PublicRoute } from '../auth/public-route';
import { WORKSPACE_ACCESS_SERVICE } from './workspaces.tokens';

const tokenSchema = z.object({ token: z.string().min(32).max(256) });

interface AuthedRequest { principal?: Principal }

function principal(request: AuthedRequest): Principal {
  if (!request.principal) throw new DomainError('DENIED', 'Authenticated session required');
  return request.principal;
}

/**
 * Tenant-facing invitation inbox. A user only sees and answers their own invitations; no e-mail is
 * sent (invitations are delivered manually by the operator).
 *
 * Static token routes are declared before the parameterised membership routes so that
 * POST /v1/invitations/token/accept is never captured by /:membershipId/accept.
 */
@Controller('v1/invitations')
export class WorkspacesController {
  constructor(@Inject(WORKSPACE_ACCESS_SERVICE) private readonly access: WorkspaceAccessService) {}

  @Get()
  list(@Req() request: AuthedRequest): Promise<readonly WorkspaceInvitationView[]> {
    return this.access.listInvitations(principal(request));
  }

  /**
   * Token-based acceptance for accounts that hold no ACTIVE membership (they cannot open a
   * workspace session). The single-use token is delivered manually by the operator: no e-mail is
   * sent while no transport is configured.
   */
  @PublicRoute()
  @Post('token/accept')
  acceptByToken(@Body() body: unknown): Promise<InvitationResponseView> {
    return this.access.acceptByToken(tokenSchema.parse(body).token);
  }

  @PublicRoute()
  @Post('token/decline')
  declineByToken(@Body() body: unknown): Promise<InvitationResponseView> {
    return this.access.declineByToken(tokenSchema.parse(body).token);
  }

  @Post(':membershipId/accept')
  accept(@Req() request: AuthedRequest, @Param('membershipId') membershipId: string): Promise<InvitationResponseView> {
    return this.access.accept(principal(request), idSchema.parse(membershipId));
  }

  @Post(':membershipId/decline')
  decline(@Req() request: AuthedRequest, @Param('membershipId') membershipId: string): Promise<InvitationResponseView> {
    return this.access.decline(principal(request), idSchema.parse(membershipId));
  }
}

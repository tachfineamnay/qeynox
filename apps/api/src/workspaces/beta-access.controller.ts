import { Body, Controller, Get, Inject, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { DomainError, type Principal } from '@qeynox/domain';
import type { WorkspaceBetaAccessService, WorkspaceBetaStatusView } from '@qeynox/application';
import { WORKSPACE_BETA_ACCESS_SERVICE } from './workspaces.tokens';

interface AuthedRequest { principal?: Principal }

function principal(request: AuthedRequest): Principal {
  if (!request.principal) throw new DomainError('DENIED', 'Authenticated session required');
  return request.principal;
}

const activateSchema = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();

/**
 * MISSION A21.02 — customer view of the acting workspace's beta access.
 * The workspace is always the one bound to the verified session (never a client-supplied id).
 * Any ACTIVE member may read the status; activation requires OWNER or ADMIN and the invitation token.
 */
@Controller('v1/workspaces/current/beta-access')
export class WorkspaceBetaAccessController {
  constructor(@Inject(WORKSPACE_BETA_ACCESS_SERVICE) private readonly beta: WorkspaceBetaAccessService) {}

  @Get()
  status(@Req() request: AuthedRequest): Promise<WorkspaceBetaStatusView> {
    return this.beta.status(principal(request));
  }

  @Post('activate')
  activate(@Req() request: AuthedRequest, @Body() body: unknown): Promise<WorkspaceBetaStatusView> {
    const input = activateSchema.parse(body);
    return this.beta.activate(principal(request), input.token);
  }
}

import { Body, Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { idSchema } from '@qeynox/contracts';
import { DomainError, type Principal } from '@qeynox/domain';
import type { WorkspaceTeamService } from '@qeynox/application';
import { WORKSPACE_TEAM_SERVICE } from './team.tokens';

interface AuthedRequest { principal?: Principal }

function principal(request: AuthedRequest): Principal {
  if (!request.principal) throw new DomainError('DENIED', 'Authenticated session required');
  return request.principal;
}

const createSchema = z.object({ name: z.string().trim().min(2).max(120) }).strict();
const inviteSchema = z.object({
  email: z.email().max(320),
  role: z.enum(['OWNER', 'ADMIN', 'MEMBER']),
  reason: z.string().trim().min(10).max(500),
}).strict();
const roleSchema = z.object({
  role: z.enum(['OWNER', 'ADMIN', 'MEMBER']),
  reason: z.string().trim().min(10).max(500),
}).strict();
const revokeSchema = z.object({ reason: z.string().trim().min(10).max(500) }).strict();
const memberQuery = z.object({
  role: z.enum(['OWNER', 'ADMIN', 'MEMBER']).optional(),
  status: z.enum(['ACTIVE', 'INVITED', 'REVOKED', 'DECLINED']).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().max(512).optional(),
}).strict();

/**
 * MISSION A18 — customer self-service workspace management.
 *
 * Every route derives the workspace from the verified session — never from a client-supplied id —
 * so a token captured in workspace A cannot act on workspace B. Management routes require an ACTIVE
 * OWNER or ADMIN membership; granting or touching OWNER memberships additionally requires OWNER.
 */
@Controller('v1/workspaces')
export class WorkspaceTeamController {
  constructor(@Inject(WORKSPACE_TEAM_SERVICE) private readonly team: WorkspaceTeamService) {}

  /** Active memberships of the caller (switchable contexts), current workspace first by name. */
  @Get()
  list(@Req() request: AuthedRequest) {
    return this.team.listMine(principal(request));
  }

  /** Self-service workspace creation; the creator becomes ACTIVE OWNER in the same transaction. */
  @Post()
  create(@Req() request: AuthedRequest, @Body() body: unknown) {
    const input = createSchema.parse(body);
    return this.team.createWorkspace(principal(request), input);
  }

  /** Detail of the acting workspace. Stats are OWNER/ADMIN-only; every ACTIVE member may read the header. */
  @Get('current')
  overview(@Req() request: AuthedRequest) {
    return this.team.overview(principal(request));
  }

  /** Team directory of the acting workspace with keyset pagination (OWNER/ADMIN). */
  @Get('current/members')
  members(@Req() request: AuthedRequest, @Query() query: unknown) {
    const input = memberQuery.parse(query);
    return this.team.listMembers(principal(request), input);
  }

  /** Invite an existing identity account into the acting workspace. Token is returned once; e-mail delivery is BLOCKED. */
  @Post('current/invitations')
  invite(@Req() request: AuthedRequest, @Body() body: unknown) {
    const input = inviteSchema.parse(body);
    return this.team.inviteMember(principal(request), input);
  }

  /** Change a membership role (OWNER/ADMIN management rules + last-owner protection in the store). */
  @Post('current/members/:membershipId/role')
  changeRole(@Req() request: AuthedRequest, @Param('membershipId') membershipId: string, @Body() body: unknown) {
    const input = roleSchema.parse(body);
    return this.team.changeMemberRole(principal(request), idSchema.parse(membershipId), input);
  }

  /** Revoke a membership or cancel a pending invitation (last-owner protection in the store). */
  @Post('current/members/:membershipId/revoke')
  revoke(@Req() request: AuthedRequest, @Param('membershipId') membershipId: string, @Body() body: unknown) {
    const input = revokeSchema.parse(body);
    return this.team.revokeMember(principal(request), idSchema.parse(membershipId), input);
  }
}

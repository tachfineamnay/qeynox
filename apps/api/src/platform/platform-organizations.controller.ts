import { Body, Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { ZodError, z } from 'zod';
import { idSchema } from '@qeynox/contracts';
import { DomainError, type PlatformPermission, type PlatformPrincipal } from '@qeynox/domain';
import type {
  InvitationResultView,
  MemberPage,
  PlatformOrganizationsService,
  PlatformPermissionContext,
  RevocationView,
  RoleChangeView,
  WorkspaceDetailView,
  WorkspacePage,
} from '@qeynox/application';
import { PlatformAccess, PlatformRoute } from '../auth/platform-route';
import { PLATFORM_ORGANIZATIONS_SERVICE } from './platform.tokens';
import type { PlatformRequest } from './platform.request';

const workspaceRead: readonly PlatformPermission[] = ['ADMINISTRATION', 'SUPPORT'];

const listQuerySchema = z.object({
  query: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).max(512).optional(),
});
const memberQuerySchema = z.object({
  role: z.enum(['OWNER', 'ADMIN', 'MEMBER']).optional(),
  status: z.enum(['ACTIVE', 'INVITED', 'REVOKED', 'DECLINED']).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).max(512).optional(),
});
const reasonSchema = z.object({ reason: z.string().trim().min(10).max(500) });
const invitationSchema = z.object({
  email: z.email(),
  role: z.enum(['OWNER', 'ADMIN', 'MEMBER']),
  reason: z.string().trim().min(10).max(500),
});
const roleChangeSchema = z.object({
  role: z.enum(['OWNER', 'ADMIN', 'MEMBER']),
  reason: z.string().trim().min(10).max(500),
});
function principal(request: PlatformRequest): PlatformPrincipal {
  if (!request.platformPrincipal) throw new DomainError('DENIED', 'Platform session required');
  return request.platformPrincipal;
}

async function parseOrAudit<T>(
  service: PlatformOrganizationsService,
  schema: z.ZodType<T>,
  value: unknown,
  request: PlatformRequest,
  context: PlatformPermissionContext,
): Promise<T> {
  try {
    return schema.parse(value);
  } catch (error: unknown) {
    if (error instanceof ZodError) await service.recordInputRejection(request.platformPrincipal, context);
    throw error;
  }
}

/**
 * Platform administration of workspaces/organisations. Reads are available to ADMINISTRATION and
 * SUPPORT; every mutation requires ADMINISTRATION, a written justification and is audited.
 * Invitations target existing identity accounts: no e-mail is sent (delivery is reported BLOCKED).
 */
@PlatformRoute()
@Controller('v1/platform/organizations')
export class PlatformOrganizationsController {
  constructor(@Inject(PLATFORM_ORGANIZATIONS_SERVICE) private readonly organizations: PlatformOrganizationsService) {}

  @PlatformAccess(workspaceRead)
  @Get()
  async list(@Req() request: PlatformRequest, @Query() query: Record<string, unknown>): Promise<WorkspacePage> {
    const actor = principal(request);
    const parsed = await parseOrAudit(this.organizations, listQuerySchema, query, request, { action: 'LIST_WORKSPACES', targetType: 'WORKSPACE' });
    return this.organizations.list(actor, parsed);
  }

  @PlatformAccess(workspaceRead)
  @Get(':workspaceId')
  async detail(@Req() request: PlatformRequest, @Param('workspaceId') workspaceId: string): Promise<WorkspaceDetailView> {
    const actor = principal(request);
    const parsedId = await parseOrAudit(this.organizations, idSchema, workspaceId, request, { action: 'READ_WORKSPACE', targetType: 'WORKSPACE', targetId: workspaceId });
    return this.organizations.get(actor, parsedId);
  }

  @PlatformAccess(workspaceRead)
  @Get(':workspaceId/members')
  async members(@Req() request: PlatformRequest, @Param('workspaceId') workspaceId: string, @Query() query: Record<string, unknown>): Promise<MemberPage> {
    const actor = principal(request);
    const parsedId = await parseOrAudit(this.organizations, idSchema, workspaceId, request, { action: 'LIST_WORKSPACE_MEMBERS', targetType: 'WORKSPACE', targetId: workspaceId });
    const parsed = await parseOrAudit(this.organizations, memberQuerySchema, query, request, { action: 'LIST_WORKSPACE_MEMBERS', targetType: 'WORKSPACE', targetId: parsedId });
    return this.organizations.listMembers(actor, parsedId, parsed);
  }

  @PlatformAccess('ADMINISTRATION')
  @Post(':workspaceId/invitations')
  async invite(@Req() request: PlatformRequest, @Param('workspaceId') workspaceId: string, @Body() body: unknown): Promise<InvitationResultView> {
    const actor = principal(request);
    const parsedId = await parseOrAudit(this.organizations, idSchema, workspaceId, request, { action: 'INVITE_WORKSPACE_MEMBER', targetType: 'WORKSPACE', targetId: workspaceId });
    const input = await parseOrAudit(this.organizations, invitationSchema, body, request, { action: 'INVITE_WORKSPACE_MEMBER', targetType: 'WORKSPACE', targetId: parsedId });
    return this.organizations.invite(actor, parsedId, input);
  }

  @PlatformAccess('ADMINISTRATION')
  @Post(':workspaceId/members/:membershipId/role')
  async changeRole(@Req() request: PlatformRequest, @Param('workspaceId') workspaceId: string, @Param('membershipId') membershipId: string, @Body() body: unknown): Promise<RoleChangeView> {
    const actor = principal(request);
    const parsedWorkspace = await parseOrAudit(this.organizations, idSchema, workspaceId, request, { action: 'CHANGE_MEMBERSHIP_ROLE', targetType: 'WORKSPACE', targetId: workspaceId });
    const parsedMembership = await parseOrAudit(this.organizations, idSchema, membershipId, request, { action: 'CHANGE_MEMBERSHIP_ROLE', targetType: 'WORKSPACE', targetId: parsedWorkspace });
    const input = await parseOrAudit(this.organizations, roleChangeSchema, body, request, { action: 'CHANGE_MEMBERSHIP_ROLE', targetType: 'WORKSPACE', targetId: parsedWorkspace });
    return this.organizations.changeRole(actor, parsedWorkspace, parsedMembership, input);
  }

  @PlatformAccess('ADMINISTRATION')
  @Post(':workspaceId/members/:membershipId/revoke')
  async revoke(@Req() request: PlatformRequest, @Param('workspaceId') workspaceId: string, @Param('membershipId') membershipId: string, @Body() body: unknown): Promise<RevocationView> {
    const actor = principal(request);
    const parsedWorkspace = await parseOrAudit(this.organizations, idSchema, workspaceId, request, { action: 'REVOKE_MEMBERSHIP', targetType: 'WORKSPACE', targetId: workspaceId });
    const parsedMembership = await parseOrAudit(this.organizations, idSchema, membershipId, request, { action: 'REVOKE_MEMBERSHIP', targetType: 'WORKSPACE', targetId: parsedWorkspace });
    const input = await parseOrAudit(this.organizations, reasonSchema, body, request, { action: 'REVOKE_MEMBERSHIP', targetType: 'WORKSPACE', targetId: parsedWorkspace });
    return this.organizations.revoke(actor, parsedWorkspace, parsedMembership, input);
  }
}

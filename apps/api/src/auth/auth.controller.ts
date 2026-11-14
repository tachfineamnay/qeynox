import { Body, Controller, Get, Headers, Inject, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { idSchema } from '@qeynox/contracts';
import { DomainError, type Principal } from '@qeynox/domain';
import { AuthService, type IdentitySession, type WorkspaceSummary } from './auth.service';
import { PublicRoute } from './public-route';
interface ReqType { principal?:Principal }
const switchWorkspaceSchema=z.object({workspaceId:idSchema});
@Controller('v1/auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth:AuthService){}
  @PublicRoute() @Post('register')
  async register(@Body()body:unknown){const session=await this.auth.register(body);return this.withWorkspaces(session);}
  @PublicRoute() @Post('login')
  async login(@Body()body:unknown){const session=await this.auth.login(body);return this.withWorkspaces(session);}
  @Post('logout')
  async logout(@Headers('authorization')authorization:string){await this.auth.logout(authorization.slice(7));return {revoked:true};}
  @Post('rotate')
  async rotate(@Headers('authorization')authorization:string,@Req()req:ReqType){
    if(!req.principal)throw new DomainError('DENIED','Session missing');
    const session=await this.auth.rotate(authorization.slice(7),req.principal.workspaceId);
    return this.withWorkspaces(session);
  }
  /** Workspace contexts available to the authenticated identity (explicit multi-workspace support). */
  @Get('workspaces')
  async workspaces(@Req()req:ReqType){
    const principal=this.principal(req);
    return {userId:principal.userId,currentWorkspaceId:principal.workspaceId,workspaces:await this.auth.listWorkspaces(principal.userId)};
  }
  @Get('me')
  async me(@Req()req:ReqType){
    const principal=this.principal(req);
    return {userId:principal.userId,workspaceId:principal.workspaceId,roles:principal.roles,workspaces:await this.auth.listWorkspaces(principal.userId)};
  }
  /** Explicit switch: the presented token is revoked and a new one is issued for the target. */
  @Post('switch-workspace')
  async switchWorkspace(@Headers('authorization')authorization:string,@Req()req:ReqType,@Body()body:unknown){
    const principal=this.principal(req);
    const input=switchWorkspaceSchema.parse(body);
    const result=await this.auth.switchWorkspace(principal.userId,input.workspaceId as never,authorization.slice(7));
    return {token:result.session.token,expiresAt:result.session.expiresAt,userId:result.session.userId,workspaceId:result.session.workspaceId,workspaces:result.workspaces};
  }
  private principal(req:ReqType):Principal{
    if(!req.principal)throw new DomainError('DENIED','Session missing');
    return req.principal;
  }
  private async withWorkspaces(session:IdentitySession):Promise<IdentitySession&{workspaces:readonly WorkspaceSummary[]}>{
    return {...session,workspaces:await this.auth.listWorkspaces(session.userId)};
  }
}

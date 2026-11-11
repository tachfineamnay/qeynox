import { Body, Controller, Headers, Post, Req } from '@nestjs/common';
import { DomainError, type Principal } from '@qeynox/domain';
import { AuthService } from './auth.service';
import { PublicRoute } from './public-route';
interface ReqType { principal?:Principal }
@Controller('v1/auth')
export class AuthController {
  constructor(private readonly auth:AuthService){}
  @PublicRoute() @Post('register')
  register(@Body()body:unknown){return this.auth.register(body);}
  @PublicRoute() @Post('login')
  login(@Body()body:unknown){return this.auth.login(body);}
  @Post('logout')
  async logout(@Headers('authorization')authorization:string){await this.auth.logout(authorization.slice(7));return {revoked:true};}
  @Post('rotate')
  rotate(@Headers('authorization')authorization:string,@Req()req:ReqType){
    if(!req.principal)throw new DomainError('DENIED','Session missing');
    return this.auth.rotate(authorization.slice(7),req.principal.workspaceId);
  }
}

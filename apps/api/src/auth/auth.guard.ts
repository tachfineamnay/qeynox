import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DomainError, type Principal } from '@qeynox/domain';
import { AuthService } from './auth.service';
import { PUBLIC_ROUTE_KEY } from './public-route';
interface AuthedRequest { headers: Record<string,string|string[]|undefined>; principal?:Principal }
@Injectable()
export class AuthenticationGuard implements CanActivate {
  constructor(@Inject(AuthService) private readonly auth:AuthService,@Inject(Reflector) private readonly reflector:Reflector){}
  async canActivate(context:ExecutionContext):Promise<boolean>{
    if(this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE_KEY,[context.getHandler(),context.getClass()]))return true;
    const req=context.switchToHttp().getRequest<AuthedRequest>();
    const authorization=req.headers.authorization;
    if(typeof authorization!=='string'||!/^Bearer [A-Za-z0-9_-]{32,256}$/.test(authorization))throw new DomainError('DENIED','Bearer session required');
    const workspace=req.headers['x-qeynox-workspace'];
    const wanted=typeof workspace==='string'?workspace:undefined;
    req.principal=await this.auth.verifyBearer(authorization.slice(7),wanted);
    return true;
  }
}

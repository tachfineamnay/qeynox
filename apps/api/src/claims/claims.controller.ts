import { Controller,Get,Param,Req,Inject } from '@nestjs/common';
import { ClaimsService } from '@qeynox/application';
import { DomainError,requireId,type Principal } from '@qeynox/domain';
import { CLAIMS_SERVICE } from './claims.tokens';
interface Authed {principal?:Principal}
@Controller('v1/operations/:operationId/claims')
export class ClaimsController {
 constructor(@Inject(CLAIMS_SERVICE)private readonly claims:ClaimsService){}
 @Get()
 list(@Req()req:Authed,@Param('operationId')operationId:string){
  if(!req.principal)throw new DomainError('DENIED','Session required');
  return this.claims.list(req.principal,requireId(operationId));
 }
}



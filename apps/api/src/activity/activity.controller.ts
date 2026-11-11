import { Controller,Get,Inject,Param,Query,Req } from '@nestjs/common';
import { DomainError,requireId,type Principal } from '@qeynox/domain';
import { OperationReadModels } from '@qeynox/application';
import { OPERATION_READMODELS } from './activity.tokens';
interface Request {principal?:Principal}
@Controller('v1/mydash')
export class ActivityController {
 constructor(@Inject(OPERATION_READMODELS)private readonly view:OperationReadModels){}
 @Get('recent')
 recent(@Req()req:Request,@Query('limit')limit?:string){
  if(!req.principal)throw new DomainError('DENIED','Session required');
  return this.view.recent(req.principal,limit?Number(limit):30);
 }
 @Get('operations/:operationId/summary')
 summary(@Req()req:Request,@Param('operationId')id:string){
  if(!req.principal)throw new DomainError('DENIED','Session required');
  return this.view.sync(req.principal,requireId(id));
 }
 @Get('operations/:operationId/activity')
 activity(@Req()req:Request,@Param('operationId')id:string,@Query('after')after?:string,@Query('limit')limit?:string){
  if(!req.principal)throw new DomainError('DENIED','Session required');
  return this.view.activity(req.principal,requireId(id),after?Number(after):0,limit?Number(limit):50);
 }
}



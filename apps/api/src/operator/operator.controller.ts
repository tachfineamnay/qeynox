import { Body,Controller,Get,Inject,Param,Post,Req } from '@nestjs/common';
import { z } from 'zod';
import { DomainError,requireId,type Principal } from '@qeynox/domain';
import { RecoveryService } from '@qeynox/application';
import { RECOVERY_SERVICE } from './operator.module';
interface Request {principal?:Principal}
const actionSchema=z.object({action:z.enum(['ESCALATE','ABANDON','RETRY_SAFE_READ']),reason:z.string().min(5).max(1000),commandKey:z.string().optional()});
@Controller('v1/operator')
export class OperatorController{
 constructor(@Inject(RECOVERY_SERVICE)private readonly recovery:RecoveryService){}
 @Get('operations/:id')
 inspect(@Req()req:Request,@Param('id')id:string){
  if(!req.principal)throw new DomainError('DENIED','Session required');
  return this.recovery.inspect(req.principal,requireId(id));
 }
 @Post('operations/:id/reconcile')
 reconcile(@Req()req:Request,@Param('id')id:string){
  if(!req.principal)throw new DomainError('DENIED','Session required');
  return this.recovery.reconcileDispatchUnknown(req.principal,requireId(id));
 }
 @Post('operations/:id/expire-approvals')
 expire(@Req()req:Request,@Param('id')id:string){
  if(!req.principal)throw new DomainError('DENIED','Session required');
  return this.recovery.expireApprovals(req.principal,requireId(id));
 }
 @Post('incidents/:id/action')
 action(@Req()req:Request,@Param('id')id:string,@Body()body:unknown){
  if(!req.principal)throw new DomainError('DENIED','Session required');
  const input=actionSchema.parse(body);
  return this.recovery.action(req.principal,requireId(id),input.action,input.reason,input.commandKey);
 }
}

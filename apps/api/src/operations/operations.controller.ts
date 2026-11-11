import { Body,Controller,Get,Inject,Param,Post,Query,Req } from '@nestjs/common';
import { z } from 'zod';
import { OperationService,OperationExecutionService,PlanningService,OperationControlService,PlanRevisionService } from '@qeynox/application';
import { DomainError,requireId,type Principal,type ID } from '@qeynox/domain';
import { createOperationSchema,operationActionSchema,planCreateSchema,revisionRequestSchema } from '@qeynox/contracts';
import { OPERATIONS_SERVICE,EXECUTION_SERVICE,PLANNING_SERVICE,CONTROLS_SERVICE,REVISIONS_SERVICE } from './operations.provider';
interface AuthedRequest {principal?:Principal}
const decideSchema=z.object({decision:z.enum(['APPROVED','REJECTED'])});
const reviseSchema=z.object({expectedVersion:z.number().int().positive(),reason:z.string().min(3),steps:planCreateSchema.shape.steps});
function principal(req:AuthedRequest):Principal{
 if(!req.principal?.workspaceId||!req.principal.userId)throw new DomainError('DENIED','Authenticated workspace required');
 return req.principal;
}
@Controller('v1/operations')
export class OperationsController {
 constructor(@Inject(OPERATIONS_SERVICE)private readonly ops:OperationService,
 @Inject(EXECUTION_SERVICE)private readonly execution:OperationExecutionService,
 @Inject(PLANNING_SERVICE)private readonly planning:PlanningService,
 @Inject(CONTROLS_SERVICE)private readonly controls:OperationControlService,
 @Inject(REVISIONS_SERVICE)private readonly revisions:PlanRevisionService){}
 @Get()
 list(@Req()req:AuthedRequest,@Query('limit')limit?:string){return this.ops.list(principal(req),limit?Number(limit):30);}
 @Post()
 create(@Req()req:AuthedRequest,@Body()body:unknown){return this.ops.create(principal(req),createOperationSchema.parse(body));}
 @Get(':id')
 get(@Req()req:AuthedRequest,@Param('id')id:string){return this.ops.get(principal(req),requireId(id));}
 @Get(':id/timeline')
 timeline(@Req()req:AuthedRequest,@Param('id')id:string){return this.ops.timeline(principal(req),requireId(id));}
 @Get(':id/results')
 results(@Req()req:AuthedRequest,@Param('id')id:string){return this.ops.results(principal(req),requireId(id));}
 @Post(':id/plan')
 createPlan(@Req()req:AuthedRequest,@Param('id')id:string,@Body()body:unknown){
  const x=planCreateSchema.parse(body);
  return this.planning.create(principal(req),requireId(id),x.expectedVersion,x.steps.map(s=>({...s,capabilityId:requireId(s.capabilityId)})));
 }
 @Post(':id/start')
 start(@Req()req:AuthedRequest,@Param('id')id:string,@Body()body:unknown){
  const x=operationActionSchema.parse(body);
  return this.execution.start(principal(req),requireId(id),x.expectedVersion,x.idempotencyKey);
 }
 @Post(':id/interrupt')
 interrupt(@Req()req:AuthedRequest,@Param('id')id:string,@Body()body:unknown){
  const x=z.object({expectedVersion:z.number().int().positive()}).parse(body);
  return this.controls.interrupt(principal(req),requireId(id),x.expectedVersion);
 }
 @Post(':id/attempts/:attemptId/redo')
 redo(@Req()req:AuthedRequest,@Param('id')id:string,@Param('attemptId')attemptId:string,@Body()body:unknown){
  const x=operationActionSchema.parse(body);
  return this.controls.requestRedo(principal(req),requireId(id),requireId(attemptId),x.expectedVersion,x.idempotencyKey);
 }
 @Post(':id/revisions/:revisionId/revise')
 revise(@Req()req:AuthedRequest,@Param('id')id:string,@Param('revisionId')revisionId:string,@Body()body:unknown){
  const x=reviseSchema.parse(body);
  return this.revisions.revise(principal(req),requireId(id),requireId(revisionId),x.expectedVersion,x.reason,x.steps.map(s=>({...s,capabilityId:requireId(s.capabilityId)})));
 }
 @Post(':id/approvals/:approvalId/decision')
 async approve(@Req()req:AuthedRequest,@Param('id')id:string,@Param('approvalId')approvalId:string,@Body()body:unknown){
  const x=decideSchema.parse(body),actor=principal(req),operationId=requireId(id);
  const approved=await this.controls.decideApproval(actor,requireId(approvalId),x.decision,operationId);
  if(approved.operationId!==operationId)throw new DomainError('DENIED','Approval operation mismatch');
  return approved;
 }
}

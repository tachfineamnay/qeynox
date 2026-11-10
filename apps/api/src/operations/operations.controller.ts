import { Body,Controller,Get,Inject,Param,Post,Query,Req } from '@nestjs/common';
import { OperationService,OperationExecutionService,PlanningService } from '@qeynox/application';
import { DomainError,requireId,type Principal } from '@qeynox/domain';
import { createOperationSchema,operationActionSchema,planCreateSchema } from '@qeynox/contracts';
import { OPERATIONS_SERVICE,EXECUTION_SERVICE,PLANNING_SERVICE } from './operations.provider';

interface AuthedRequest { principal?: Principal }
function requirePrincipal(request:AuthedRequest):Principal {
  if(!request.principal?.workspaceId||!request.principal.userId)throw new DomainError('DENIED','Authenticated workspace session required');
  return request.principal;
}
@Controller('v1/operations')
export class OperationsController {
  constructor(@Inject(OPERATIONS_SERVICE)private readonly operations:OperationService,
    @Inject(EXECUTION_SERVICE)private readonly execution:OperationExecutionService,
    @Inject(PLANNING_SERVICE)private readonly planning:PlanningService) {}
  @Get()
  list(@Req()req:AuthedRequest,@Query('limit')limit?:string){return this.operations.list(requirePrincipal(req),limit?Number(limit):30);}
  @Post()
  create(@Req()req:AuthedRequest,@Body()body:unknown){return this.operations.create(requirePrincipal(req),createOperationSchema.parse(body));}
  @Get(':id')
  get(@Req()req:AuthedRequest,@Param('id')id:string){return this.operations.get(requirePrincipal(req),requireId(id));}
  @Get(':id/timeline')
  timeline(@Req()req:AuthedRequest,@Param('id')id:string){return this.operations.timeline(requirePrincipal(req),requireId(id));}
  @Get(':id/results')
  results(@Req()req:AuthedRequest,@Param('id')id:string){return this.operations.results(requirePrincipal(req),requireId(id));}
  @Post(':id/plan')
  createPlan(@Req()req:AuthedRequest,@Param('id')id:string,@Body()body:unknown){
    const x=planCreateSchema.parse(body);
    return this.planning.create(requirePrincipal(req),requireId(id),x.expectedVersion,x.steps.map(s=>({...s,capabilityId:requireId(s.capabilityId)})));
  }
  @Post(':id/start')
  start(@Req()req:AuthedRequest,@Param('id')id:string,@Body()body:unknown){
    const x=operationActionSchema.parse(body);
    return this.execution.start(requirePrincipal(req),requireId(id),x.expectedVersion,x.idempotencyKey);
  }
}

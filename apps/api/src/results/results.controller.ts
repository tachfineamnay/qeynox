import { Controller,Get,Inject,Param,Req } from '@nestjs/common';
import { DomainError,requireId,type Principal } from '@qeynox/domain';
import { ResultAssembler,ArtifactDelivery } from '@qeynox/application';
import { RESULT_ASSEMBLER,ARTIFACT_DELIVERY } from './results.module';
interface Request {principal?:Principal}
@Controller('v1/operations/:operationId/documents')
export class ResultsController {
 constructor(@Inject(RESULT_ASSEMBLER)private readonly docs:ResultAssembler,@Inject(ARTIFACT_DELIVERY)private readonly artifacts:ArtifactDelivery){}
 @Get()
 list(@Req()req:Request,@Param('operationId')operationId:string){
  if(!req.principal)throw new DomainError('DENIED','Workspace required');
  return this.docs.list(req.principal,requireId(operationId));
 }
 @Get(':documentId')
 detail(@Req()req:Request,@Param('operationId')operationId:string,@Param('documentId')documentId:string){
  if(!req.principal)throw new DomainError('DENIED','Workspace required');
  return this.docs.get(req.principal,requireId(operationId),requireId(documentId));
 }
 @Get(':documentId/artifacts/:artifactId')
 async grant(@Req()req:Request,@Param('operationId')operationId:string,@Param('artifactId')artifactId:string){
  if(!req.principal)throw new DomainError('DENIED','Workspace required');
  return {url:await this.artifacts.readGrant(req.principal,requireId(operationId),requireId(artifactId))};
 }
}

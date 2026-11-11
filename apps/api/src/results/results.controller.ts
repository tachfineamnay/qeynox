import { Body,Controller,Get,Inject,Param,Post,Req } from '@nestjs/common';
import { DomainError,requireId,type Principal } from '@qeynox/domain';
import { ResultAssembler,ArtifactDelivery,ResultDeliveryService,exportHtml,exportJson } from '@qeynox/application';
import { RESULT_ASSEMBLER,ARTIFACT_DELIVERY,RESULT_DELIVERY } from './results.tokens';
interface Request {principal?:Principal}
@Controller('v1/operations/:operationId/documents')
export class ResultsController {
 constructor(@Inject(RESULT_ASSEMBLER)private readonly docs:ResultAssembler,@Inject(ARTIFACT_DELIVERY)private readonly artifacts:ArtifactDelivery,@Inject(RESULT_DELIVERY)private readonly delivery:ResultDeliveryService){}
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
 async grant(@Req()req:Request,@Param('operationId')operationId:string,@Param('documentId')documentId:string,@Param('artifactId')artifactId:string){
  if(!req.principal)throw new DomainError('DENIED','Workspace required');
  return {url:await this.artifacts.readGrant(req.principal,requireId(operationId),requireId(documentId),requireId(artifactId))};
 }
 @Post(':documentId/export/:format')
 async exportArtifact(@Req()req:Request,@Param('operationId')operationId:string,@Param('documentId')documentId:string,@Param('format')format:string){
  if(!req.principal)throw new DomainError('DENIED','Workspace required');
  if(format!=='json'&&format!=='html')throw new DomainError('UNSUPPORTED','Only JSON/HTML exports implemented');
  const doc=await this.docs.get(req.principal,requireId(operationId),requireId(documentId));
  const data=format==='json'?exportJson(doc):exportHtml(doc);
  return this.artifacts.save(req.principal,doc,format,data);
 }
 @Post(':documentId/deliver')
 deliverResult(@Req()req:Request,@Param('operationId')operationId:string,@Param('documentId')documentId:string,@Body()body:unknown){
  if(!req.principal)throw new DomainError('DENIED','Workspace required');
  const approvalId=(body as {approvalId?:unknown}|undefined)?.approvalId;
  if(typeof approvalId!=='string')throw new DomainError('INVALID_INPUT','Approval ID required');
  return this.delivery.deliver(req.principal,requireId(operationId),requireId(documentId),requireId(approvalId));
 }
}



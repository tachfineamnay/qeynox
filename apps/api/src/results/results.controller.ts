import { Body,Controller,Get,Inject,Param,Post,Req } from '@nestjs/common';
import { DomainError,requireId,type Principal } from '@qeynox/domain';
import { ResultAssembler,ArtifactDelivery,ResultDeliveryService,exportHtml,exportJson,exportPdf,classifyDocument,documentVerdict } from '@qeynox/application';
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
 /** Re-assembles the review version from current claim assessments; earlier versions are kept. */
 @Post('assemble')
 reassemble(@Req()req:Request,@Param('operationId')operationId:string){
  if(!req.principal)throw new DomainError('DENIED','Workspace required');
  return this.docs.reassemble(req.principal,requireId(operationId));
 }
 @Get(':documentId')
 detail(@Req()req:Request,@Param('operationId')operationId:string,@Param('documentId')documentId:string){
  if(!req.principal)throw new DomainError('DENIED','Workspace required');
  return this.docs.get(req.principal,requireId(operationId),requireId(documentId));
 }
 @Post('reconcile')
 reconcilePending(@Req()req:Request,@Param('operationId')operationId:string){
  if(!req.principal)throw new DomainError('DENIED','Workspace required');
  return this.artifacts.reconcilePending(req.principal,requireId(operationId));
 }
 @Get(':documentId/artifacts/:artifactId')
 async grant(@Req()req:Request,@Param('operationId')operationId:string,@Param('documentId')documentId:string,@Param('artifactId')artifactId:string){
  if(!req.principal)throw new DomainError('DENIED','Workspace required');
  return {url:await this.artifacts.readGrant(req.principal,requireId(operationId),requireId(documentId),requireId(artifactId))};
 }
 /**
  * Renders one document into json, html or pdf and stores it as a private artifact.
  *
  * The three formats share one classification, so a finding printed as "unresolved" on screen cannot
  * be printed as a conclusion in the PDF. PDF re-derivation is deterministic, which keeps the
  * artifact digest meaningful for reconciliation.
  */
 @Post(':documentId/export/:format')
 async exportArtifact(@Req()req:Request,@Param('operationId')operationId:string,@Param('documentId')documentId:string,@Param('format')format:string){
  if(!req.principal)throw new DomainError('DENIED','Workspace required');
  if(format!=='json'&&format!=='html'&&format!=='pdf')throw new DomainError('UNSUPPORTED','Supported exports are json, html and pdf');
  const doc=await this.docs.get(req.principal,requireId(operationId),requireId(documentId));
  const data=format==='json'?exportJson(doc):format==='html'?exportHtml(doc):await exportPdf(doc);
  const saved=await this.artifacts.save(req.principal,doc,format,data);
  return {...saved,format,contentType:format==='json'?'application/json':format==='html'?'text/html':'application/pdf'};
 }
 /**
  * Review-facing view of one document: what is verified, what is interpretation and what is
  * unresolved, with the single document verdict. Derived on read, never stored, so it cannot drift
  * from the document a reviewer actually sees.
  */
 @Get(':documentId/atlas')
 async atlas(@Req()req:Request,@Param('operationId')operationId:string,@Param('documentId')documentId:string){
  if(!req.principal)throw new DomainError('DENIED','Workspace required');
  const doc=await this.docs.get(req.principal,requireId(operationId),requireId(documentId));
  const c=classifyDocument(doc);
  return {
   documentId:doc.id,version:doc.version,status:doc.status,verdict:documentVerdict(doc,c),
   counts:c.counts,deliverable:c.deliverable,
   verified:c.verified.map(f=>({claimId:f.finding.claimId,statement:f.finding.statement,citations:f.verifiableCitations})),
   unresolved:c.unresolved.map(f=>({claimId:f.finding.claimId,statement:f.finding.statement,blockers:f.blockers})),
   awaitingAssessment:c.awaitingAssessment.map(f=>({claimId:f.finding.claimId,statement:f.finding.statement,blockers:f.blockers})),
   interpretations:c.interpretations.map(f=>({claimId:f.finding.claimId,statement:f.finding.statement})),
   // P09: business-pack AI synthesis; statements only, no claim identity because they are not claims.
   packInterpretations:[...(doc.interpretations??[])],
   ...(doc.businessPack?{businessPack:{pack:doc.businessPack.pack,contractKey:doc.businessPack.contractKey}}:{}),
  };
 }
 @Post(':documentId/deliver')
 deliverResult(@Req()req:Request,@Param('operationId')operationId:string,@Param('documentId')documentId:string,@Body()body:unknown){
  if(!req.principal)throw new DomainError('DENIED','Workspace required');
  const approvalId=(body as {approvalId?:unknown}|undefined)?.approvalId;
  if(typeof approvalId!=='string')throw new DomainError('INVALID_INPUT','Approval ID required');
  return this.delivery.deliver(req.principal,requireId(operationId),requireId(documentId),requireId(approvalId));
 }
}



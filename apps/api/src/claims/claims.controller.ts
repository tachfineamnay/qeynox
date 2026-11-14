import { Body,Controller,Get,Inject,Param,Post,Req } from '@nestjs/common';
import { z } from 'zod';
import { ClaimsService } from '@qeynox/application';
import { DomainError,requireId,type Principal } from '@qeynox/domain';
import { CLAIMS_SERVICE } from './claims.tokens';
interface Authed {principal?:Principal}
const registerSchema=z.object({
  attemptId:z.string().min(4),statement:z.string().trim().min(3).max(10000),kind:z.string().trim().min(2).max(120),
  profileId:z.string().min(1).optional(),profileVersion:z.number().int().positive().optional(),
});
const attachSchema=z.object({
  sourceId:z.string().min(4),relationship:z.enum(['SUPPORTS','CONTRADICTS']),
  evidenceId:z.string().min(4),observationDigest:z.string().regex(/^[a-fA-F0-9]{64}$/),
});
const assessActiveSchema=z.object({
  reviewerDecision:z.enum(['SUPPORTED','DISPROVEN','CONFLICTING']).optional(),
  reason:z.string().trim().min(5).max(2000).optional(),
});
const assessSchema=z.object({
  capabilityId:z.string().min(4),policyVersion:z.number().int().positive(),
  reason:z.string().trim().min(5).max(2000),reviewerDecision:z.enum(['SUPPORTED','DISPROVEN','CONFLICTING']).optional(),
});
function principal(req:Authed):Principal{
 if(!req.principal?.workspaceId||!req.principal.userId)throw new DomainError('DENIED','Session required');
 return req.principal;
}
@Controller('v1/operations/:operationId/claims')
export class ClaimsController {
 constructor(@Inject(CLAIMS_SERVICE)private readonly claims:ClaimsService){}
 private async requireClaim(req:Authed,operationId:string,claimId:string){
  const claim=await this.claims.get(principal(req),requireId(claimId));
  if(claim.operationId!==requireId(operationId))throw new DomainError('DENIED','Claim does not belong to the requested operation');
  return claim;
 }
 @Get()
 list(@Req()req:Authed,@Param('operationId')operationId:string){
  return this.claims.list(principal(req),requireId(operationId));
 }
 @Post()
 register(@Req()req:Authed,@Param('operationId')operationId:string,@Body()body:unknown){
  const input=registerSchema.parse(body);
  return this.claims.register(principal(req),{
    operationId:requireId(operationId),attemptId:requireId(input.attemptId),statement:input.statement,kind:input.kind,
    profileId:input.profileId?requireId(input.profileId):undefined,profileVersion:input.profileVersion,
  });
 }
 @Get(':claimId')
 async get(@Req()req:Authed,@Param('operationId')operationId:string,@Param('claimId')claimId:string){
  return this.requireClaim(req,operationId,claimId);
 }
 @Post(':claimId/evidence')
 async attach(@Req()req:Authed,@Param('operationId')operationId:string,@Param('claimId')claimId:string,@Body()body:unknown){
  const input=attachSchema.parse(body);
  await this.requireClaim(req,operationId,claimId);
  return this.claims.attach(principal(req),requireId(claimId),requireId(input.sourceId),input.relationship,requireId(input.evidenceId),input.observationDigest);
 }
 /** Evaluates the claim against the active policy for its own capability, with optional human review. */
 @Post(':claimId/assess-active')
 async assessActive(@Req()req:Authed,@Param('operationId')operationId:string,@Param('claimId')claimId:string,@Body()body:unknown){
  const input=assessActiveSchema.parse(body??{});
  await this.requireClaim(req,operationId,claimId);
  if(input.reviewerDecision&&!input.reason)throw new DomainError('INVALID_INPUT','Review rationale required');
  return this.claims.assessActive(principal(req),requireId(claimId),{reviewerDecision:input.reviewerDecision,reason:input.reason});
 }
 @Post(':claimId/assess')
 async assess(@Req()req:Authed,@Param('operationId')operationId:string,@Param('claimId')claimId:string,@Body()body:unknown){
  const input=assessSchema.parse(body);
  await this.requireClaim(req,operationId,claimId);
  return this.claims.assess(principal(req),{
    claimId:requireId(claimId),capabilityId:requireId(input.capabilityId),policyVersion:input.policyVersion,
    reason:input.reason,reviewerDecision:input.reviewerDecision,
  });
 }
}

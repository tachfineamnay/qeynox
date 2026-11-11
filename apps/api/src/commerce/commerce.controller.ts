import { Body,Controller,Get,Inject,Param,Post,Req } from '@nestjs/common';
import { z } from 'zod';
import { DomainError,requireId,type Principal } from '@qeynox/domain';
import { CommerceService } from '@qeynox/application';
import { COMMERCE_SERVICE } from './commerce.module';
interface Authed {principal?:Principal}
const makeQuote=z.object({offerId:z.string().min(1),revisionId:z.string().min(4)});
const accept=z.object({idempotencyKey:z.string().min(8).max(200)});
@Controller('v1/operations/:operationId/commercial')
export class CommerceController{
 constructor(@Inject(COMMERCE_SERVICE)private readonly commerce:CommerceService){}
 @Post('quote')
 quote(@Req()req:Authed,@Param('operationId')operationId:string,@Body()body:unknown){
  if(!req.principal)throw new DomainError('DENIED','Session required');
  const b=makeQuote.parse(body);return this.commerce.quote(req.principal,requireId(operationId),b.offerId,requireId(b.revisionId));
 }
 @Post('quotes/:quoteId/accept')
 accept(@Req()req:Authed,@Param('quoteId')quoteId:string,@Body()body:unknown){
  if(!req.principal)throw new DomainError('DENIED','Session required');
  return this.commerce.accept(req.principal,requireId(quoteId),accept.parse(body).idempotencyKey);
 }
}

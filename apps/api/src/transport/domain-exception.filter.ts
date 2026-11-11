import { ArgumentsHost,Catch,ExceptionFilter,HttpException } from '@nestjs/common';
import { ZodError } from 'zod';
import { DomainError } from '@qeynox/domain';
@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
 catch(exception:unknown,host:ArgumentsHost){
  const res=host.switchToHttp().getResponse<{status(code:number):{json(value:unknown):void}}>();
  if(exception instanceof DomainError){
   const status=({DENIED:403,NOT_FOUND:404,CONFLICT:409,INVALID_STATE:409,NOT_CONFIGURED:503,UNSUPPORTED:501,INVALID_INPUT:400,PAYMENT_REQUIRED:402,PAYMENT_NOT_CONFIGURED:503,UNKNOWN_OUTCOME:409,BUDGET_EXHAUSTED:429} as Record<string,number>)[exception.code]??400;
   return res.status(status).json({error:{code:exception.code,message:exception.message}});
  }
  if(exception instanceof ZodError)return res.status(400).json({error:{code:'INVALID_INPUT',message:'Request validation failed'}});
  if(exception instanceof HttpException)return res.status(exception.getStatus()).json({error:{code:'HTTP_ERROR',message:exception.message}});
  return res.status(500).json({error:{code:'INTERNAL_ERROR',message:'Unexpected error'}});
 }
}

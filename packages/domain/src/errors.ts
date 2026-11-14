export type DomainErrorCode='INVALID_INPUT'|'INVALID_STATE'|'DENIED'|'CONFLICT'|'NOT_FOUND'|'NOT_CONFIGURED'|'UNAVAILABLE'|'UNSUPPORTED'|'PAYMENT_REQUIRED'|'PAYMENT_NOT_CONFIGURED'|'UNKNOWN_OUTCOME'|'BUDGET_EXHAUSTED';
export class DomainError extends Error {
 constructor(public readonly code:DomainErrorCode,message:string,public readonly context?:Readonly<Record<string,string>>){
  super(message);this.name='DomainError';
 }
}

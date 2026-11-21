export type DomainErrorCode='INVALID_INPUT'|'INVALID_STATE'|'DENIED'|'CONFLICT'|'NOT_FOUND'|'NOT_CONFIGURED'|'UNAVAILABLE'|'UNSUPPORTED'|'PAYMENT_REQUIRED'|'PAYMENT_NOT_CONFIGURED'|'UNKNOWN_OUTCOME'|'BUDGET_EXHAUSTED'
 // A06: an unexpected execution failure must be distinguishable from a known domain refusal.
 // It is a real code stored on the attempt, not a placeholder for "unknown".
 |'UNEXPECTED_EXECUTION_ERROR'
 // A21.01: payments are frozen by server policy (QEYNOX_COMMERCE_MODE). Distinct from
 // PAYMENT_NOT_CONFIGURED: a configured provider credential can never lift this refusal.
 |'PAYMENTS_FROZEN';
export class DomainError extends Error {
 constructor(public readonly code:DomainErrorCode,message:string,public readonly context?:Readonly<Record<string,string>>){
  super(message);this.name='DomainError';
 }
}

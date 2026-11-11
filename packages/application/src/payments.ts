import { DomainError } from '@qeynox/domain';
export interface PaymentIntentRequest {orderId:string;amountMinor:number;currency:string;idempotencyKey:string}
export interface PaymentReceipt {providerId:string;status:'AUTHORIZED'|'CAPTURED'|'FAILED';amountMinor:number;currency:string}
export interface PaymentPort {
 authorize(request:PaymentIntentRequest):Promise<PaymentReceipt>;
 capture(intentId:string,idempotencyKey:string):Promise<PaymentReceipt>;
 refund(captureId:string,amountMinor:number,idempotencyKey:string):Promise<PaymentReceipt>;
 verifyWebhook(signature:string,payload:Uint8Array):Promise<{eventId:string;orderId:string;kind:string}>;
 reconcile(orderId:string):Promise<PaymentReceipt|undefined>;
}
export class DisabledPaymentProvider implements PaymentPort {
 private fail():never{throw new DomainError('PAYMENT_NOT_CONFIGURED','Payment provider is not configured');}
 async authorize():Promise<never>{return this.fail();}
 async capture():Promise<never>{return this.fail();}
 async refund():Promise<never>{return this.fail();}
 async verifyWebhook():Promise<never>{return this.fail();}
 async reconcile():Promise<never>{return this.fail();}
}

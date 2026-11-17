import { z } from 'zod';

export const flowEventSchema=z.object({
 id:z.string().min(1).max(200),eventId:z.string().min(1).max(200),
 sequence:z.number().int().positive().safe(),kind:z.string().min(1).max(200),occurredAt:z.iso.datetime(),
}).strict();
export const flowWireSchema=z.discriminatedUnion('name',[
 z.object({type:z.literal('CUSTOM'),name:z.literal('qeynox.flow.event.v1'),value:z.object({operationId:z.string().min(1).max(200),event:flowEventSchema}).strict()}).strict(),
 z.object({type:z.literal('CUSTOM'),name:z.literal('qeynox.flow.snapshot.v1'),value:z.object({operationId:z.string().min(1).max(200),watermark:z.number().int().nonnegative().safe()}).strict()}).strict(),
 z.object({type:z.literal('CUSTOM'),name:z.literal('qeynox.flow.control.v1'),value:z.object({code:z.enum(['RESNAPSHOT','SESSION_ENDED','UNAVAILABLE'])}).strict()}).strict(),
]);
export function parseFlowCursor(value:string|null):number|null {
 if(value===null)return 0;
 if(!/^(0|[1-9][0-9]*)$/.test(value))return null;
 const cursor=Number(value);
 return Number.isSafeInteger(cursor)?cursor:null;
}

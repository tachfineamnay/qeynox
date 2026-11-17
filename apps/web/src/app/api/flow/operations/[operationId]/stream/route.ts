import { api,ApiError,session } from '../../../../../../lib/api';
import { activitySchema,summarySchema } from '../../../../../../lib/mission';
import { flowWireSchema,parseFlowCursor } from '../../../../../../lib/flow-stream-contract';

export const runtime='nodejs';
export const dynamic='force-dynamic';
let active=0;
const maxConnections=100;
const denied=(error:unknown)=>error instanceof ApiError&&['DENIED','NOT_FOUND','SESSION_REQUIRED'].includes(error.code);

export async function GET(request:Request,{params}:{params:Promise<{operationId:string}>}){
 const origin=request.headers.get('origin'),site=request.headers.get('sec-fetch-site');
 if((origin&&origin!==new URL(request.url).origin)||(site&&site!=='same-origin'&&site!=='none'))return new Response(null,{status:403});
 const {operationId}=await params;
 if(!/^[A-Za-z0-9_-]{4,200}$/.test(operationId))return new Response(null,{status:400});
 const header=request.headers.get('last-event-id'),query=new URL(request.url).searchParams.get('after');
 const h=parseFlowCursor(header),q=parseFlowCursor(query);
 if(h===null||q===null)return new Response(null,{status:400});
 let cursor=header===null?q:h;
 if(!await session())return new Response(null,{status:403});
 if(active>=maxConnections)return new Response(null,{status:503});
 const prefix='/v1/mydash/operations/'+encodeURIComponent(operationId);
 try {
  const summary=summarySchema.parse(await api(prefix+'/summary'));
  if(cursor>summary.lastSequence)return new Response(null,{status:409,headers:{'Cache-Control':'no-store'}});
 } catch(error){return new Response(null,{status:denied(error)?403:503,headers:{'Cache-Control':'no-store'}});}
 active++;
 let closed=false;
 let caughtUp=false;
 const seen=new Set<string>();
 const encoder=new TextEncoder();
 const close=()=>{if(!closed){closed=true;active--;}};
 const stream=new ReadableStream<Uint8Array>({
  async pull(controller){
   if(closed)return;
   const control=(code:'SESSION_ENDED'|'UNAVAILABLE'|'RESNAPSHOT')=>{
    if(closed)return;
    const message=flowWireSchema.parse({type:'CUSTOM',name:'qeynox.flow.control.v1',value:{code}});
    controller.enqueue(encoder.encode('data: '+JSON.stringify(message)+'\n\n'));close();controller.close();
   };
   try {
    if(request.signal.aborted){close();controller.close();return;}
    const page=activitySchema.parse(await api(prefix+'/activity?after='+cursor+'&limit=1'));
    if(closed)return;
    if(page.events.length){
     const item=page.events[0]!;
     if(item.sequence!==cursor+1||page.nextCursor!==item.sequence||seen.has(item.eventId)||seen.size>=10000||!/^[A-Z][A-Z0-9_]{0,119}$/.test(item.kind)||!/^[A-Za-z0-9_-]{4,200}$/.test(item.id)||!/^[A-Za-z0-9_-]{4,200}$/.test(item.eventId)){control('RESNAPSHOT');return;}
     const message=flowWireSchema.parse({type:'CUSTOM',name:'qeynox.flow.event.v1',value:{operationId,event:{id:item.id,eventId:item.eventId,sequence:item.sequence,kind:item.kind,occurredAt:item.occurredAt}}});
     seen.add(item.eventId);cursor=item.sequence;
     controller.enqueue(encoder.encode('id: '+cursor+'\ndata: '+JSON.stringify(message)+'\n\n'));
    }else{
     if(page.nextCursor!==cursor){control('RESNAPSHOT');return;}
     if(!caughtUp){
      const snapshot=flowWireSchema.parse({type:'CUSTOM',name:'qeynox.flow.snapshot.v1',value:{operationId,watermark:cursor}});
      controller.enqueue(encoder.encode('data: '+JSON.stringify(snapshot)+'\n\n'));caughtUp=true;
     }else controller.enqueue(encoder.encode(': heartbeat\n\n'));
     await new Promise<void>(resolve=>{const done=()=>{clearTimeout(timer);request.signal.removeEventListener('abort',done);resolve();};const timer=setTimeout(done,5000);request.signal.addEventListener('abort',done,{once:true});});
    }
   } catch(error){if(!closed)control(denied(error)?'SESSION_ENDED':'UNAVAILABLE');}
  },
  cancel(){close();},
 });
 request.signal.addEventListener('abort',close,{once:true});
 return new Response(stream,{headers:{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store, no-transform','X-Accel-Buffering':'no','X-Content-Type-Options':'nosniff'}});
}

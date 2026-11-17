'use client';
import { useEffect,useRef } from 'react';
import { useRouter } from 'next/navigation';
import { flowWireSchema } from '../../lib/flow-stream-contract';
import { acceptFlowEvent } from '../../lib/flow-live';

export function FlowLiveRefresh({operationId,watermark,onLiveEvent}:{operationId:string;watermark:number|null;onLiveEvent:(id:string)=>void}){
 const router=useRouter();
 const callback=useRef(onLiveEvent);callback.current=onLiveEvent;
 const latestWatermark=useRef(watermark);latestWatermark.current=watermark;
 const ready=watermark!==null;
 useEffect(()=>{
  let disposed=false,ended=false,connected=false,replaying=true,needsRefresh=false,resetCursor=false,openedAt=0;
  let stream:EventSource|undefined,lastRefresh=Date.now(),lastAttempt=0;
  let probe:AbortController|undefined;
  const state={cursor:watermark??0,seen:new Set<string>()};
  const refresh=(urgent=false)=>{
   needsRefresh=true;
   if(!urgent&&(document.hidden||document.activeElement?.closest('form')))return;
   needsRefresh=false;lastRefresh=Date.now();router.refresh();
  };
  const connect=()=>{
   if(disposed||ended||stream||probe||!ready||document.hidden||(resetCursor&&needsRefresh))return;
   lastAttempt=Date.now();
   if(resetCursor&&latestWatermark.current!==null){state.cursor=latestWatermark.current;state.seen.clear();resetCursor=false;}
   const source=new EventSource('/api/flow/operations/'+encodeURIComponent(operationId)+'/stream?after='+state.cursor);
   stream=source;
   source.onopen=()=>{connected=true;openedAt=Date.now();replaying=true;};
   source.onmessage=event=>{
    let raw:unknown;try{raw=JSON.parse(event.data);}catch{source.close();stream=undefined;connected=false;replaying=true;refresh();return;}
    const message=flowWireSchema.safeParse(raw);
    if(!message.success){source.close();stream=undefined;connected=false;replaying=true;refresh();return;}
    if(message.data.name==='qeynox.flow.control.v1'){
     source.close();stream=undefined;connected=false;replaying=true;
     if(message.data.value.code==='SESSION_ENDED'){ended=true;refresh(true);return;}
     if(message.data.value.code==='RESNAPSHOT'){resetCursor=true;refresh();return;}
     refresh();return;
    }
    if(message.data.name==='qeynox.flow.snapshot.v1'){
     if(message.data.value.operationId!==operationId||message.data.value.watermark!==state.cursor){source.close();stream=undefined;connected=false;resetCursor=true;refresh();return;}
     replaying=false;return;
    }
    const outcome=acceptFlowEvent(state,operationId,event.data,event.lastEventId);
    if(outcome==='invalid'){source.close();stream=undefined;connected=false;replaying=true;resetCursor=true;refresh();return;}
    if(outcome==='new'){if(!replaying)callback.current(message.data.value.event.eventId);refresh();}
   };
   source.onerror=()=>{
    source.close();if(stream===source)stream=undefined;connected=false;replaying=true;
    const abort=new AbortController();probe=abort;
    const timeout=window.setTimeout(()=>abort.abort(),10000);
    void fetch('/api/flow/operations/'+encodeURIComponent(operationId)+'/stream?after='+state.cursor,{cache:'no-store',signal:abort.signal})
     .then(async response=>{await response.body?.cancel();if(disposed)return;if(response.status===403){ended=true;refresh(true);}else{if(response.status===409)resetCursor=true;refresh();}})
     .catch(()=>{if(!disposed)refresh();})
     .finally(()=>{window.clearTimeout(timeout);if(probe===abort)probe=undefined;});
   };
  };
  connect();
  const tick=window.setInterval(()=>{
   if(disposed||ended)return;
   const now=Date.now();
   if(stream&&connected&&now-openedAt>=30000){stream.close();stream=undefined;connected=false;replaying=true;lastAttempt=0;}
   if(needsRefresh||now-lastRefresh>=(connected?60000:10000))refresh();
   if(!stream&&now-lastAttempt>=20000)connect();
  },5000);
  const resume=()=>{
   if(document.hidden){if(stream){stream.close();stream=undefined;connected=false;replaying=true;}return;}
   if(needsRefresh)refresh();if(!stream&&!ended)connect();
  };
  let focusTimer:number|undefined;
  const afterFocus=()=>{window.clearTimeout(focusTimer);focusTimer=window.setTimeout(resume,0);};
  document.addEventListener('visibilitychange',resume);document.addEventListener('focusout',afterFocus);
  return()=>{disposed=true;window.clearInterval(tick);window.clearTimeout(focusTimer);probe?.abort();stream?.close();document.removeEventListener('visibilitychange',resume);document.removeEventListener('focusout',afterFocus);};
 },[operationId,ready,router]);
 return null;
}

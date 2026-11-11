import { z } from 'zod';
import { DomainError,type ID } from '@qeynox/domain';
import type { ToolConnector,ToolDefinition,ToolContext } from '../types';
import type { ConnectorManifest } from '../manifest';
import type { EgressPolicy } from '../egress';

const request=z.object({
 country:z.string().regex(/^[A-Za-z]{2,3}$/).transform(x=>x.toUpperCase()),
 indicator:z.string().regex(/^[A-Za-z0-9.]{3,40}$/).transform(x=>x.toUpperCase()),
 mostRecent:z.number().int().min(1).max(5).default(3),
});
const row=z.object({
 country:z.object({id:z.string(),value:z.string()}),
 indicator:z.object({id:z.string(),value:z.string()}),
 date:z.string(),
 value:z.number().nullable(),
 countryiso3code:z.string().optional(),
 obs_status:z.string().optional(),
});
const payload=z.array(z.unknown()).length(2);
const output=z.object({provider:z.literal('world-bank'),country:z.string(),indicator:z.string(),observations:z.array(row),sourceUri:z.url(),retrievedAt:z.string()});
export class WorldBankConnector implements ToolConnector {
 readonly id='world-bank';readonly version='1';
 constructor(private readonly capabilities:readonly ID[],private readonly egress:EgressPolicy){}
 definitions():readonly ToolDefinition[]{
  return [{name:'indicator',version:'1',mode:'READ',requiredScopes:[],allowedCapabilities:this.capabilities,input:request,output,timeoutMs:10000,maxCostUnits:0}];
 }
 async invoke(name:string,version:string,input:unknown,context:ToolContext){
  if(name!=='indicator'||version!==this.version)throw new DomainError('UNSUPPORTED','Unknown World Bank tool');
  const values=request.parse(input);
  const url=new URL('https://api.worldbank.org/v2/country/'+encodeURIComponent(values.country)+'/indicator/'+encodeURIComponent(values.indicator));
  url.searchParams.set('format','json');url.searchParams.set('mrnev',String(values.mostRecent));url.searchParams.set('per_page','5');
  this.egress.assertAllowed(url);
  const response=await fetch(url,{method:'GET',signal:context.signal,redirect:'error',headers:{accept:'application/json'}});
  if(!response.ok)throw new DomainError('INVALID_STATE','World Bank responded HTTP '+response.status);
  const text=await response.text();
  if(text.length>500000)throw new DomainError('INVALID_STATE','Provider payload too large');
  const body=payload.parse(JSON.parse(text)), observations=z.array(row).parse(body[1]);
  const result={provider:'world-bank' as const,country:values.country,indicator:values.indicator,observations,sourceUri:url.toString(),retrievedAt:new Date().toISOString()};
  return {value:output.parse(result),sourceUri:url.toString()};
 }
}
export const worldBankManifest:ConnectorManifest={
 id:'world-bank',version:'1',description:'World Bank Indicators API v2',provider:'World Bank',
 regions:['GLOBAL'],operations:['INDICATOR_RESEARCH'],
 licenseNotes:'Verify data reuse and attribution terms; figures may be published with a delay.',
 termsUrl:'https://datahelpdesk.worldbank.org/knowledgebase/articles/889392',
 freshness:{ttlSeconds:86400,publishedAtSource:'UNKNOWN'},
 rateLimit:{maxPerMinute:30},mode:'READ_ONLY',tools:[{name:'indicator',version:'1'}],
};


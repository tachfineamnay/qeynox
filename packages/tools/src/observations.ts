import { createHash } from 'node:crypto';
import type { Provenance } from './types';
export interface ResearchObservation {
 id:string;workspaceId:string;operationId:string;provider:string;tool:string;
 queryDigest:string;responseDigest:string;sourceUri?:string;
 retrievedAt:string;publishedAt?:string;cachedUntil?:string;
 claimStatus:'UNVERIFIED'|'SOURCE_CAPTURED';content:unknown;
 limitations:readonly string[];
}
export const digestQuery=(provider:string,parameters:unknown)=>createHash('sha256').update(JSON.stringify({provider,parameters})).digest('hex');
export function normalizeObservation(args:{workspaceId:string;operationId:string;provider:string;tool:string;query:unknown;result:unknown;provenance:Provenance;ttlSeconds:number}):ResearchObservation {
 return {id:crypto.randomUUID(),workspaceId:args.workspaceId,operationId:args.operationId,provider:args.provider,tool:args.tool,queryDigest:digestQuery(args.provider,args.query),responseDigest:args.provenance.responseDigest,sourceUri:args.provenance.sourceUri,retrievedAt:args.provenance.retrievedAt,publishedAt:args.provenance.publishedAt,cachedUntil:args.ttlSeconds?new Date(Date.parse(args.provenance.retrievedAt)+args.ttlSeconds*1000).toISOString():undefined,claimStatus:'SOURCE_CAPTURED',content:args.result,limitations:['Source capture is not independently verified']};
}

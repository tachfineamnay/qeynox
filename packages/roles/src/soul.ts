import { and, eq } from 'drizzle-orm';
import { DomainError, contextSubset, newId, type Consent, type ID, type Principal, type UserContext } from '@qeynox/domain';
import { QeyNoxStore, consents } from '@qeynox/persistence';
import type { EnginePort, EngineOutcome } from '@qeynox/engine';
import { AgentProfileStore } from './profiles';

export class SoulService {
  constructor(private readonly store:QeyNoxStore,private readonly profiles:AgentProfileStore,private readonly engine:EnginePort) {}

  async grantConsent(actor:Principal,purpose:string,scopes:readonly string[],expiresAt?:string):Promise<Consent> {
    if(!scopes.length||!purpose.trim())throw new DomainError('INVALID_INPUT','Consent must name purpose and scopes');
    const consent:Consent={id:newId(),userId:actor.userId,workspaceId:actor.workspaceId,purpose,scopes,grantedAt:new Date().toISOString(),expiresAt,version:1};
    await this.store.putConsent(consent);
    return consent;
  }
  async revokeConsent(actor:Principal,consentId:ID):Promise<void> {
    const [value]=await this.store.db.select().from(consents).where(and(eq(consents.id,consentId),eq(consents.workspaceId,actor.workspaceId),eq(consents.userId,actor.userId))).limit(1);
    if(!value)throw new DomainError('NOT_FOUND','Consent does not exist');
    if(value.payload.revokedAt)return;
    await this.store.db.update(consents).set({payload:{...value.payload,revokedAt:new Date().toISOString(),version:value.payload.version+1}}).where(eq(consents.id,consentId));
  }
  async saveFact(actor:Principal,key:string,value:unknown,consentId:ID):Promise<UserContext> {
    const consents=await this.store.getConsents(actor.workspaceId,actor.userId);
    const permit=consents.find(c=>c.id===consentId);
    if(!permit || permit.revokedAt || (permit.expiresAt && permit.expiresAt<=new Date().toISOString()) || !permit.scopes.includes('context:write'))throw new DomainError('DENIED','Context write consent absent');
    if(!key.trim() || key.length>80)throw new DomainError('INVALID_INPUT','Context key invalid');
    const old=(await this.store.getContext(actor.workspaceId,actor.userId)).find(x=>x.key===key&&!x.deletedAt);
    const now=new Date().toISOString();
    const fact:UserContext={id:old?.id??newId(),workspaceId:actor.workspaceId,ownerUserId:actor.userId,key,value,consentId,origin:'USER',createdAt:old?.createdAt??now,updatedAt:now};
    await this.store.saveContext(fact);return fact;
  }
  async viewContext(actor:Principal):Promise<readonly UserContext[]> {
    const items=await this.store.getContext(actor.workspaceId,actor.userId);
    const permits=await this.store.getConsents(actor.workspaceId,actor.userId);
    return contextSubset(items,permits,['context:read'],new Date().toISOString());
  }
  async deleteFact(actor:Principal,factId:ID):Promise<void> {
    const value=(await this.store.getContext(actor.workspaceId,actor.userId)).find(x=>x.id===factId);
    if(!value)throw new DomainError('NOT_FOUND','Context fact missing');
    await this.store.saveContext({...value,value:null,deletedAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
  }
  async converse(actor:Principal,message:string,operationId:ID,attemptId:ID):Promise<EngineOutcome> {
    const profile=await this.profiles.getActive('soul');
    if(message.length>5000)throw new DomainError('INVALID_INPUT','Message too long');
    const facts=await this.viewContext(actor);
    const selective=Object.fromEntries(facts.filter(f=>profile.permittedContextKeys.includes(f.key)).map(f=>[f.key,f.value]));
    return this.engine.invoke({workspaceId:actor.workspaceId,operationId,stepAttemptId:attemptId,profile,userMessage:message,context:selective,correlationId:newId()});
  }
}

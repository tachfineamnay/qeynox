import { and,eq,inArray,lt } from 'drizzle-orm';
import { DomainError,newId,type ID,type Principal } from '@qeynox/domain';
import { QeyNoxStore,operations,outbox,executions,attempts,toolLedger,approvals,recoveryIncidents,recoveryActions } from '@qeynox/persistence';
import { OperationControlService } from './controls';
export interface RuntimeObservation {state:'RUNNING'|'SUCCEEDED'|'FAILED'|'CANCELLED'|'UNKNOWN';observedAt:string;externalRunId:string}
export interface RuntimeInspector {observe(runId:string):Promise<RuntimeObservation|'UNSUPPORTED'>}
export class UnconfiguredRuntimeInspector implements RuntimeInspector{
 async observe():Promise<'UNSUPPORTED'>{return 'UNSUPPORTED';}
}
export class RecoveryService{
 constructor(private readonly store:QeyNoxStore,private readonly inspector:RuntimeInspector=new UnconfiguredRuntimeInspector()){}
 private requireOperator(actor:Principal){
  if(!actor.roles.some(role=>['OWNER','ADMIN','OPERATOR'].includes(role)))throw new DomainError('DENIED','Operator role required');
 }
 async inspect(actor:Principal,operationId:ID){
  this.requireOperator(actor);
  await this.store.getOperation(actor,operationId);
  const [queued,links,attemptRows,ledger]=await Promise.all([
   this.store.db.select().from(outbox).where(and(eq(outbox.workspaceId,actor.workspaceId),eq(outbox.operationId,operationId))),
   this.store.db.select().from(executions).where(eq(executions.operationId,operationId)),
   this.store.db.select().from(attempts).where(eq(attempts.operationId,operationId)),
   this.store.db.select().from(toolLedger).where(and(eq(toolLedger.workspaceId,actor.workspaceId),eq(toolLedger.operationId,operationId))),
  ]);
  return {
   operationId,
   dispatch:queued.map(q=>({id:q.id,state:q.state,topic:q.topic,attempts:q.attempts,lastErrorCode:q.lastError})),
   executions:links.map(x=>({id:x.id,runId:x.workflowRunId,status:x.payload.status,attemptId:x.attemptId})),
   attempts:attemptRows.map(a=>({id:a.id,stepId:a.stepId,state:a.state,sequence:a.sequence})),
   toolOutcomes:ledger.map(t=>({intentId:t.intentId,outcome:t.outcome,connector:t.connector})),
  };
 }
 async reconcileDispatchUnknown(actor:Principal,operationId:ID){
  this.requireOperator(actor);
  const snapshot=await this.inspect(actor,operationId);
  const unresolved=snapshot.dispatch.filter(x=>x.state==='UNKNOWN'||x.state==='DISPATCHING');
  const incidents=[];
  for(const item of unresolved){
   const [existing]=await this.store.db.select().from(recoveryIncidents).where(and(eq(recoveryIncidents.workspaceId,actor.workspaceId),eq(recoveryIncidents.operationId,operationId),eq(recoveryIncidents.outboxId,item.id),eq(recoveryIncidents.status,'OPEN'))).limit(1);
   if(existing){incidents.push(existing);continue;}
   const value={id:newId(),workspaceId:actor.workspaceId,operationId,outboxId:item.id,category:'UNCONFIRMED_DISPATCH',status:'OPEN',reason:'Dispatch may have reached Hatchet; no automatic replay',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
   await this.store.db.insert(recoveryIncidents).values(value);
   incidents.push(value);
  }
  return incidents;
 }
 async inspectRun(actor:Principal,operationId:ID,runId:string){
  this.requireOperator(actor);await this.store.getOperation(actor,operationId);
  const [run]=await this.store.db.select().from(executions).where(and(eq(executions.operationId,operationId),eq(executions.workflowRunId,runId))).limit(1);
  if(!run)throw new DomainError('NOT_FOUND','Run not linked to operation');
  const status=await this.inspector.observe(runId);
  if(status==='UNSUPPORTED')throw new DomainError('UNSUPPORTED','Hatchet run inspection is not configured');
  return status;
 }
 async action(actor:Principal,incidentId:ID,action:'ESCALATE'|'ABANDON'|'RETRY_SAFE_READ',reason:string,commandKey?:string){
  this.requireOperator(actor);
  if(!reason||reason.length<5)throw new DomainError('INVALID_INPUT','Operator reason required');
  const [incident]=await this.store.db.select().from(recoveryIncidents).where(and(eq(recoveryIncidents.id,incidentId),eq(recoveryIncidents.workspaceId,actor.workspaceId))).limit(1);
  if(!incident||incident.status!=='OPEN')throw new DomainError('NOT_FOUND','Open incident not found');
  await this.store.getOperation(actor,incident.operationId as ID);
  if(action==='RETRY_SAFE_READ'){
   // No replay of ambiguous dispatch: an existing run may have caused side effects.
   if(incident.category==='UNCONFIRMED_DISPATCH')throw new DomainError('UNKNOWN_OUTCOME','Reconcile possible Hatchet dispatch before retry');
   const [ambiguous]=await this.store.db.select().from(toolLedger).where(and(eq(toolLedger.workspaceId,actor.workspaceId),eq(toolLedger.operationId,incident.operationId),eq(toolLedger.outcome,'UNKNOWN'))).limit(1);
   if(ambiguous)throw new DomainError('UNKNOWN_OUTCOME','A tool write may have succeeded remotely');
   throw new DomainError('UNSUPPORTED','Safe retry requires a verified read-only classification and runtime observation');
  }
  const now=new Date().toISOString(),status=action==='ABANDON'?'ABANDONED':'ESCALATED';
  await this.store.db.transaction(async tx=>{
   const [current]=await tx.select().from(recoveryIncidents).where(and(eq(recoveryIncidents.id,incidentId),eq(recoveryIncidents.status,'OPEN'))).for('update').limit(1);
   if(!current)throw new DomainError('CONFLICT','Incident already handled');
   await tx.update(recoveryIncidents).set({status,updatedAt:now}).where(eq(recoveryIncidents.id,incidentId));
   await tx.insert(recoveryActions).values({id:newId(),incidentId,workspaceId:actor.workspaceId,operationId:incident.operationId,actorId:actor.userId,action,reason,createdAt:now,details:{}});
  });
  return {incidentId,status};
 }
 async expireApprovals(actor:Principal,operationId:ID){
  this.requireOperator(actor);await this.store.getOperation(actor,operationId);
  const rows=await this.store.db.select().from(approvals).where(and(eq(approvals.operationId,operationId),eq(approvals.workspaceId,actor.workspaceId),eq(approvals.status,'PENDING')));
  let expired=0;
  for(const row of rows){
   if(row.payload.expiresAt>=new Date().toISOString())continue;
   const changed=await this.store.db.update(approvals).set({status:'EXPIRED',payload:{...row.payload,status:'EXPIRED'}}).where(and(eq(approvals.id,row.id),eq(approvals.status,'PENDING'))).returning({id:approvals.id});
   if(changed.length)expired++;
  }
  return {expired};
 }
}

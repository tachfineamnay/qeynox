import type { Pool } from 'pg';
import { DomainError,newId,type ID,type ExecutionLink } from '@qeynox/domain';
import type { OrchestratorPort } from './port';
interface OutboxItem {id:string;workspace_id:ID;operation_id:ID;payload:Record<string,unknown>;topic:string}
// The lease prevents an interrupted dispatch from remaining invisible forever. Expiry is
// uncertain, never permission to enqueue a second run without Hatchet reconciliation.
const DISPATCH_LEASE_MS=15*60_000;
export class PgOutboxDispatcher {
  constructor(private readonly pool:Pool,private readonly orchestrator:OrchestratorPort){}
  async dispatchOnce():Promise<number> {
    const client=await this.pool.connect();const locked:OutboxItem[]=[];
    try {
      await client.query('BEGIN');
      const now=new Date().toISOString();
      // Crash after claiming but before the Hatchet acknowledgement: we cannot know if
      // the external enqueue occurred. Surface an incident; NEVER replay automatically.
      const abandoned=await client.query<OutboxItem>("SELECT id,workspace_id,operation_id,payload,topic FROM outbox WHERE state='DISPATCHING' AND next_attempt_at<=$1 ORDER BY next_attempt_at LIMIT 20 FOR UPDATE SKIP LOCKED",[now]);
      for(const event of abandoned.rows){
        await client.query("UPDATE outbox SET state='UNKNOWN',last_error='DISPATCH_LEASE_EXPIRED' WHERE id=$1 AND state='DISPATCHING'",[event.id]);
        await client.query(
          "INSERT INTO recovery_incidents (id,workspace_id,operation_id,outbox_id,category,status,reason,created_at,updated_at) SELECT $1,$2,$3,$4,'UNCONFIRMED_DISPATCH','OPEN','Dispatch lease expired; inspect Hatchet before replay',$5,$5 WHERE NOT EXISTS (SELECT 1 FROM recovery_incidents WHERE outbox_id=$4 AND status='OPEN')",
          [newId(),event.workspace_id,event.operation_id,event.id,now],
        );
      }
      const result=await client.query<OutboxItem>("SELECT id,workspace_id,operation_id,payload,topic FROM outbox WHERE state='PENDING' AND next_attempt_at<=$1 ORDER BY created_at LIMIT 10 FOR UPDATE SKIP LOCKED",[now]);
      const leaseExpiresAt=new Date(Date.now()+DISPATCH_LEASE_MS).toISOString();
      for(const event of result.rows){
        // Reuse next_attempt_at as a dispatch-lease deadline while DISPATCHING; no schema change.
        await client.query("UPDATE outbox SET state='DISPATCHING',attempts=attempts+1,next_attempt_at=$2 WHERE id=$1",[event.id,leaseExpiresAt]);
        locked.push(event);
      }
      await client.query('COMMIT');
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    for(const event of locked) {
      if(event.topic!=='EXECUTE_STEP'){await this.pool.query("UPDATE outbox SET state='FAILED',last_error='Unsupported topic' WHERE id=$1",[event.id]);continue;}
      const p=event.payload;
      if(typeof p.planRevisionId!=='string'||typeof p.stepAttemptId!=='string'||typeof p.idempotencyKey!=='string'){
        await this.pool.query("UPDATE outbox SET state='FAILED',last_error='Invalid event payload' WHERE id=$1",[event.id]);continue;
      }
      try {
        const execution=await this.orchestrator.enqueue({workspaceId:event.workspace_id,operationId:event.operation_id,planRevisionId:p.planRevisionId as ID,stepAttemptId:p.stepAttemptId as ID,idempotencyKey:p.idempotencyKey});
        const now=new Date().toISOString(),linkId=newId();
        const link:ExecutionLink={id:linkId,operationId:event.operation_id,revisionId:p.planRevisionId as ID,stepAttemptId:p.stepAttemptId as ID,provider:'HATCHET',workflowRunId:execution.workflowRunId,status:'SCHEDULED',observedAt:now};
        const tx=await this.pool.connect();
        try {
          await tx.query('BEGIN');
          await tx.query("INSERT INTO execution_links (id,operation_id,attempt_id,provider,workflow_run_id,payload) VALUES ($1,$2,$3,$4,$5,$6)",[linkId,event.operation_id,p.stepAttemptId,'HATCHET',execution.workflowRunId,JSON.stringify(link)]);
          await tx.query("UPDATE outbox SET state='SENT',sent_at=$2,last_error=NULL WHERE id=$1",[event.id,now]);
          await tx.query('COMMIT');
        }catch(error){await tx.query('ROLLBACK');throw error;}finally{tx.release();}
      }catch(error:unknown){
        // Unknown outcome: network may have scheduled a run. Manual reconciliation, never blind replay.
        await this.pool.query("UPDATE outbox SET state='UNKNOWN',last_error=$2 WHERE id=$1",[event.id,error instanceof DomainError?error.code:'DISPATCH_INDETERMINATE']);
      }
    }
    return locked.length;
  }
}

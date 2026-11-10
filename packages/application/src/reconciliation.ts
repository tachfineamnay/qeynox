import type { Pool } from 'pg';
import { DomainError,type ID,type Principal } from '@qeynox/domain';
import { QeyNoxStore } from '@qeynox/persistence';

export interface ReconciliationIssue { eventId:string;operationId:string;status:string;reason:string }
export class OperationReconciliationService {
  constructor(private readonly pool:Pool,private readonly store:QeyNoxStore){}
  async listUnknown(actor:Principal,operationId:ID):Promise<ReconciliationIssue[]> {
    await this.store.getOperation(actor,operationId);
    const {rows}=await this.pool.query<{id:string;operation_id:string;state:string;last_error:string|null}>(
      "SELECT id,operation_id,state,last_error FROM outbox WHERE workspace_id=$1 AND operation_id=$2 AND state IN ('UNKNOWN','FAILED') ORDER BY created_at",[actor.workspaceId,operationId]
    );
    return rows.map(r=>({eventId:r.id,operationId:r.operation_id,status:r.state,reason:r.last_error??'Unresolved'}));
  }
  async confirmCancellation(_actor:Principal,_operationId:ID,_version:number):Promise<never> {
    // Must observe a real Hatchet run status through a documented API before transition.
    throw new DomainError('UNSUPPORTED','Verified Hatchet cancellation observation is not implemented');
  }
}

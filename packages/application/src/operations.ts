import type { ID,Principal,OperationStatus } from '@qeynox/domain';
import type { QeyNoxStore } from '@qeynox/persistence';
import type { CreateOperationInput } from '@qeynox/contracts';
export class OperationService {
  constructor(private readonly store:QeyNoxStore) {}
  create(actor:Principal,input:CreateOperationInput){return this.store.createOperation(actor,input.title,input.goal,input.constraints);}
  get(actor:Principal,operationId:ID){return this.store.getOperation(actor,operationId);}
  list(actor:Principal,limit=30){return this.store.listOperations(actor,limit);}
  timeline(actor:Principal,operationId:ID){return this.store.timeline(actor,operationId);}
  results(actor:Principal,operationId:ID){return this.store.getResult(actor,operationId);}
  transition(actor:Principal,operationId:ID,next:OperationStatus,expectedVersion:number){return this.store.transition(actor,operationId,next,expectedVersion);}
}

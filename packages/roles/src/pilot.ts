import { DomainError, type ID, type Principal, type OperationStatus } from '@qeynox/domain';
import { QeyNoxStore } from '@qeynox/persistence';
import type { EnginePort, EngineOutcome } from '@qeynox/engine';
import { CapabilityRegistry } from './capabilities';
import { AgentProfileStore } from './profiles';

export interface PilotNextAction {
  operationId: ID; status: OperationStatus; action:'DEFINE_PLAN'|'START'|'REVIEW_APPROVAL'|'WAIT'|'VIEW_RESULT'|'REVISE';
  reason:string;
}
export class PilotService {
  constructor(
    private readonly store:QeyNoxStore,
    private readonly capabilities:CapabilityRegistry,
    private readonly profiles:AgentProfileStore,
    private readonly engine:EnginePort
  ) {}
  async nextAction(actor:Principal,operationId:ID):Promise<PilotNextAction> {
    const op=await this.store.getOperation(actor,operationId);
    const actionByStatus:Record<OperationStatus,PilotNextAction['action']>={
      DRAFT:'DEFINE_PLAN',READY:'START',RUNNING:'WAIT',WAITING_APPROVAL:'REVIEW_APPROVAL',
      INTERRUPT_REQUESTED:'WAIT',INTERRUPTED:'REVISE',FAILED:'REVISE',COMPLETED:'VIEW_RESULT',SUPERSEDED:'VIEW_RESULT',
    };
    return {operationId:op.id,status:op.status,action:actionByStatus[op.status],reason:'Based on recorded operation state only'};
  }
  async proposeBusinessStep(actor:Principal,operationId:ID,attemptId:ID,capabilityId:ID,question:string):Promise<EngineOutcome> {
    const op=await this.store.getOperation(actor,operationId);
    if(!op.currentRevisionId)throw new DomainError('INVALID_STATE','Operation has no selected plan');
    const capability=this.capabilities.get(capabilityId);
    const profile=await this.profiles.getActive('pilot');
    return this.engine.invoke({
      workspaceId:actor.workspaceId,operationId,stepAttemptId:attemptId,profile,
      userMessage:question,
      context:{capability:{id:capability.id,purpose:capability.purpose,scope:capability.scope},operation:{id:op.id,title:op.title,status:op.status}},
      correlationId:crypto.randomUUID(),
    });
  }
  async operationOverview(actor:Principal):Promise<readonly {id:ID;title:string;status:OperationStatus;lastActivityAt:string}[]> {
    return (await this.store.listOperations(actor,80)).map(o=>({id:o.id,title:o.title,status:o.status,lastActivityAt:o.lastActivityAt}));
  }
}

import { assembleResult, type ID, type Principal, type Evidence, type Artifact } from '@qeynox/domain';
import { QeyNoxStore } from '@qeynox/persistence';

export class ResultService {
  constructor(private readonly store:QeyNoxStore) {}
  async prepareDraft(actor:Principal,operationId:ID,revisionId:ID,title:string,summary:string,evidence:readonly Evidence[],artifacts:readonly Artifact[]) {
    await this.store.getOperation(actor,operationId);
    const last=(await this.store.getResult(actor,operationId))[0];
    const result=assembleResult({
      workspaceId:actor.workspaceId,operationId,revisionId,version:(last?.version??0)+1,title,summary,
      evidence,artifacts,prior:last,now:new Date().toISOString(),
    });
    await this.store.recordResult(result);
    return result;
  }
}

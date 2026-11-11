export type FeatureSupport='SUPPORTED_BY_CODE'|'REQUIRES_CONFIG'|'UNSUPPORTED'|'NOT_VERIFIED';
export interface OrchestratorCapabilities {
 id:string;runtimeVersion:string;dispatch:FeatureSupport;observedRunId:FeatureSupport;
 cancellation:FeatureSupport;approvalWait:FeatureSupport;
 replaySafety:FeatureSupport;streaming:FeatureSupport;notes:readonly string[];
}
export const hatchetCapabilities:OrchestratorCapabilities={
 id:'hatchet',runtimeVersion:'1.46.1',
 dispatch:'REQUIRES_CONFIG',observedRunId:'SUPPORTED_BY_CODE',cancellation:'SUPPORTED_BY_CODE',
 approvalWait:'NOT_VERIFIED',replaySafety:'NOT_VERIFIED',streaming:'UNSUPPORTED',
 notes:['Hatchet task, outbox dispatch, run-ID mapping and cancellation now use the installed SDK contracts (WorkflowRunRef.getWorkflowRunId, runs.cancel, runs.getDetails)',
 'No Hatchet server or client token was available in this environment: live dispatch/run observation/cancellation remain NOT VERIFIED',
 'Business revision always creates new plan lineage; replay of ambiguous dispatch requires operator reconciliation'],
};

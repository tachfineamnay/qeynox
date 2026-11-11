export type FeatureSupport='SUPPORTED_BY_CODE'|'REQUIRES_CONFIG'|'UNSUPPORTED'|'NOT_VERIFIED';
export interface OrchestratorCapabilities {
 id:string;runtimeVersion:string;dispatch:FeatureSupport;observedRunId:FeatureSupport;
 cancellation:FeatureSupport;approvalWait:FeatureSupport;
 replaySafety:FeatureSupport;streaming:FeatureSupport;notes:readonly string[];
}
export const hatchetCapabilities:OrchestratorCapabilities={
 id:'hatchet',runtimeVersion:'1.46.1',
 dispatch:'REQUIRES_CONFIG',observedRunId:'NOT_VERIFIED',cancellation:'UNSUPPORTED',
 approvalWait:'NOT_VERIFIED',replaySafety:'NOT_VERIFIED',streaming:'UNSUPPORTED',
 notes:['Hatchet task and outbox are source-coded only','No run-ID/cancellation status was confirmed by execution','Business revision always creates new plan lineage'],
};

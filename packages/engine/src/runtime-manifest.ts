export type FeatureSupport='SUPPORTED_BY_CODE'|'REQUIRES_CONFIG'|'UNSUPPORTED'|'NOT_VERIFIED';
export interface RuntimeCapabilities {
 id:string;runtimeVersion:string;
 invocation:FeatureSupport;streaming:FeatureSupport;cancellation:FeatureSupport;
 structuredOutputs:FeatureSupport;nativeToolControl:FeatureSupport;
 usageMetering:FeatureSupport;approvalEvents:FeatureSupport;
 runtimeIdentity:FeatureSupport;isolation:FeatureSupport;
 notes:readonly string[];
}
export const hermesCapabilities:RuntimeCapabilities={
 id:'hermes',runtimeVersion:'UNVERIFIED',
 invocation:'REQUIRES_CONFIG',streaming:'UNSUPPORTED',cancellation:'UNSUPPORTED',
 structuredOutputs:'NOT_VERIFIED',nativeToolControl:'UNSUPPORTED',
 usageMetering:'NOT_VERIFIED',approvalEvents:'UNSUPPORTED',
 runtimeIdentity:'NOT_VERIFIED',isolation:'NOT_VERIFIED',
 notes:['OpenAI-compatible text invocation is coded but has not been called or compiled',
 'Native tools and network egress must be demonstrably isolated before use with customer data',
 'A language model switch is not agent runtime replacement'],
};

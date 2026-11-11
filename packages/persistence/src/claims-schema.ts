import { pgTable,text,integer,jsonb,index,uniqueIndex } from 'drizzle-orm/pg-core';
export type ClaimStatus='UNVERIFIED'|'SUPPORTED'|'CONFLICTING'|'STALE'|'DISPROVEN'|'NEEDS_HUMAN_REVIEW';
export const claims=pgTable('claims',{
 id:text('id').primaryKey(),workspaceId:text('workspace_id').notNull(),operationId:text('operation_id').notNull(),
 attemptId:text('attempt_id').notNull(),statement:text('statement').notNull(),kind:text('kind').notNull(),
 status:text('status').$type<ClaimStatus>().notNull().default('UNVERIFIED'),
 createdAt:text('created_at').notNull(),profileId:text('profile_id'),profileVersion:integer('profile_version'),
},t=>[index('claim_workspace_operation_idx').on(t.workspaceId,t.operationId)]);
export const claimEvidenceLinks=pgTable('claim_evidence_links',{
 id:text('id').primaryKey(),claimId:text('claim_id').notNull().references(()=>claims.id),
 sourceId:text('source_id').notNull(),evidenceId:text('evidence_id'),relationship:text('relationship').notNull(),
 observationDigest:text('observation_digest'),addedAt:text('added_at').notNull(),
},t=>[uniqueIndex('claim_source_relation_unique').on(t.claimId,t.sourceId,t.relationship)]);
export const verificationPolicies=pgTable('verification_policies',{
 id:text('id').primaryKey(),capabilityId:text('capability_id').notNull(),version:integer('version').notNull(),
 minimumSources:integer('minimum_sources').notNull(),maxAgeDays:integer('max_age_days').notNull(),
 approvedProviders:jsonb('approved_providers').$type<string[]>().notNull(),
 humanReviewRequired:text('human_review_required').notNull(),validFrom:text('valid_from').notNull(),
},t=>[uniqueIndex('verification_policy_version_unique').on(t.capabilityId,t.version)]);
export const claimAssessments=pgTable('claim_assessments',{
 id:text('id').primaryKey(),claimId:text('claim_id').notNull().references(()=>claims.id),
 policyId:text('policy_id').notNull().references(()=>verificationPolicies.id),
 status:text('status').$type<ClaimStatus>().notNull(),method:text('method').notNull(),
 actorId:text('actor_id'),rationale:text('rationale').notNull(),sourceIds:jsonb('source_ids').$type<string[]>().notNull(),
 assessedAt:text('assessed_at').notNull(),
},t=>[index('claim_assessments_claim_idx').on(t.claimId,t.assessedAt)]);
export const sourceSnapshots=pgTable('source_snapshots',{
 id:text('id').primaryKey(),workspaceId:text('workspace_id').notNull(),operationId:text('operation_id').notNull(),
 sourceId:text('source_id').notNull(),provider:text('provider').notNull(),retrievedAt:text('retrieved_at').notNull(),
 publishedAt:text('published_at'),sha256:text('sha256'),storageKey:text('storage_key'),citationUri:text('citation_uri'),
 createdAt:text('created_at').notNull(),
});

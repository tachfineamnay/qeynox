import { pgTable, text, integer, jsonb, boolean, index, uniqueIndex } from 'drizzle-orm/pg-core';
import type {
  Operation, Goal, Consent, UserContext, CapabilityDefinition, OperationPlan, PlanRevision, WorkStep,
  StepAttempt, ApprovalRequest, ExecutionLink, EventRecord, Source, Evidence, Artifact, ResultVersion,
  ToolInvocationIntent,
} from '@qeynox/domain';

export const operations = pgTable('operations', {
  id: text('id').primaryKey(), workspaceId: text('workspace_id').notNull(),
  createdBy: text('created_by').notNull(), goalId: text('goal_id').notNull(),
  status: text('status').notNull(), version: integer('version').notNull(),
  currentRevisionId: text('current_revision_id'), lastActivityAt: text('last_activity_at').notNull(),
  payload: jsonb('payload').$type<Operation>().notNull(),
}, t => [index('operation_workspace_activity_idx').on(t.workspaceId, t.lastActivityAt)]);

export const goals = pgTable('goals', {
  id: text('id').primaryKey(), operationId: text('operation_id').notNull(),
  payload: jsonb('payload').$type<Goal>().notNull(),
});

export const plans = pgTable('operation_plans', {
  id: text('id').primaryKey(), operationId: text('operation_id').notNull().unique(),
  payload: jsonb('payload').$type<OperationPlan>().notNull(),
});
export const planRevisions = pgTable('plan_revisions', {
  id: text('id').primaryKey(), operationId: text('operation_id').notNull(),
  planId: text('plan_id').notNull(), revision: integer('revision').notNull(),
  payload: jsonb('payload').$type<PlanRevision>().notNull(),
}, t => [uniqueIndex('revisions_plan_seq_unique').on(t.planId, t.revision)]);

export const steps = pgTable('work_steps', {
  id: text('id').primaryKey(), operationId: text('operation_id').notNull(),
  revisionId: text('revision_id').notNull(),
  payload: jsonb('payload').$type<WorkStep>().notNull(),
}, t => [index('steps_revision_idx').on(t.revisionId)]);

export const attempts = pgTable('step_attempts', {
  id: text('id').primaryKey(), operationId: text('operation_id').notNull(),
  stepId: text('step_id').notNull(), revisionId: text('revision_id').notNull(),
  sequence: integer('sequence').notNull(), state: text('state').notNull(),
  payload: jsonb('payload').$type<StepAttempt>().notNull(),
}, t => [uniqueIndex('attempt_step_seq_unique').on(t.stepId, t.sequence)]);

export const consents = pgTable('consents', {
  id: text('id').primaryKey(), workspaceId: text('workspace_id').notNull(),
  userId: text('user_id').notNull(), payload: jsonb('payload').$type<Consent>().notNull(),
});
export const contexts = pgTable('user_contexts', {
  id: text('id').primaryKey(), workspaceId: text('workspace_id').notNull(),
  ownerUserId: text('owner_user_id').notNull(), payload: jsonb('payload').$type<UserContext>().notNull(),
});
export const capabilities = pgTable('capabilities', {
  id: text('id').primaryKey(), slot: integer('slot').notNull(),
  version: integer('version').notNull(), status: text('status').notNull(),
  payload: jsonb('payload').$type<CapabilityDefinition>().notNull(),
}, t => [uniqueIndex('capability_slot_version_unique').on(t.slot, t.version)]);

export const approvals = pgTable('approval_requests', {
  id: text('id').primaryKey(), workspaceId: text('workspace_id').notNull(),
  operationId: text('operation_id').notNull(), status: text('status').notNull(),
  payload: jsonb('payload').$type<ApprovalRequest>().notNull(),
});
export const executions = pgTable('execution_links', {
  id: text('id').primaryKey(), operationId: text('operation_id').notNull(),
  attemptId: text('attempt_id').notNull(), provider: text('provider').notNull(),
  workflowRunId: text('workflow_run_id'),
  payload: jsonb('payload').$type<ExecutionLink>().notNull(),
});
export const events = pgTable('operation_events', {
  id: text('id').primaryKey(), workspaceId: text('workspace_id').notNull(),
  operationId: text('operation_id').notNull(), kind: text('kind').notNull(),
  occurredAt: text('occurred_at').notNull(), payload: jsonb('payload').$type<EventRecord>().notNull(),
}, t => [index('events_operation_time_idx').on(t.operationId, t.occurredAt)]);

export const outbox = pgTable('outbox', {
  id: text('id').primaryKey(), workspaceId: text('workspace_id').notNull(),
  operationId: text('operation_id').notNull(),
  idempotencyKey: text('idempotency_key').notNull().unique(),
  topic: text('topic').notNull(), payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  state: text('state').notNull().default('PENDING'), attempts: integer('attempts').notNull().default(0),
  nextAttemptAt: text('next_attempt_at').notNull(), createdAt: text('created_at').notNull(),
  sentAt: text('sent_at'), lastError: text('last_error'),
}, t => [index('outbox_state_due_idx').on(t.state, t.nextAttemptAt)]);

export const sources = pgTable('sources', {
  id: text('id').primaryKey(), workspaceId: text('workspace_id').notNull(),
  operationId: text('operation_id').notNull(), payload: jsonb('payload').$type<Source>().notNull(),
});
export const evidences = pgTable('evidence', {
  id: text('id').primaryKey(), operationId: text('operation_id').notNull(),
  attemptId: text('attempt_id').notNull(), payload: jsonb('payload').$type<Evidence>().notNull(),
});
export const artifacts = pgTable('artifacts', {
  id: text('id').primaryKey(), workspaceId: text('workspace_id').notNull(),
  operationId: text('operation_id').notNull(), payload: jsonb('payload').$type<Artifact>().notNull(),
});
export const results = pgTable('result_versions', {
  id: text('id').primaryKey(), workspaceId: text('workspace_id').notNull(),
  operationId: text('operation_id').notNull(), version: integer('version').notNull(),
  payload: jsonb('payload').$type<ResultVersion>().notNull(),
}, t => [uniqueIndex('result_operation_version_unique').on(t.operationId, t.version)]);

export const toolIntents = pgTable('tool_invocation_intents', {
  id: text('id').primaryKey(), operationId: text('operation_id').notNull(),
  idempotencyKey: text('idempotency_key').notNull().unique(),
  payload: jsonb('payload').$type<ToolInvocationIntent>().notNull(),
});
export const toolLedger = pgTable('tool_execution_ledger', {
  id: text('id').primaryKey(), workspaceId: text('workspace_id').notNull(),
  operationId: text('operation_id').notNull(), attemptId: text('attempt_id').notNull(),
  intentId: text('intent_id').notNull().unique(), connector: text('connector').notNull(),
  outcome: text('outcome').notNull(), requestDigest: text('request_digest').notNull(),
  result: jsonb('result').$type<Record<string, unknown>>(),
  createdAt: text('created_at').notNull(), updatedAt: text('updated_at').notNull(),
});
export const agentProfiles = pgTable('agent_profiles', {
  id: text('id').primaryKey(), roleKey: text('role_key').notNull(),
  version: integer('version').notNull(), active: boolean('active').notNull().default(false),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
}, t => [uniqueIndex('agent_profile_version_unique').on(t.roleKey, t.version)]);

export const commandIds = pgTable('command_idempotency', {
  id: text('id').primaryKey(), workspaceId: text('workspace_id').notNull(),
  operationId: text('operation_id').notNull(), commandKey: text('command_key').notNull(),
  outcome: jsonb('outcome').$type<Record<string, unknown>>().notNull(),
  createdAt: text('created_at').notNull(),
}, t => [uniqueIndex('command_key_workspace_unique').on(t.workspaceId, t.commandKey)]);

import type { ID } from './identities';

export type ISODate = string;
export type Principal = Readonly<{ userId: ID; workspaceId: ID; roles: readonly string[] }>;
export type Workspace = Readonly<{ id: ID; ownerUserId: ID; name: string; createdAt: ISODate }>;
export type User = Readonly<{ id: ID; preferredLocale?: string; createdAt: ISODate }>;

export type Consent = Readonly<{
  id: ID; workspaceId: ID; userId: ID; purpose: string; scopes: readonly string[];
  grantedAt: ISODate; revokedAt?: ISODate; expiresAt?: ISODate; version: number;
}>;
export type UserContext = Readonly<{
  id: ID; workspaceId: ID; ownerUserId: ID; key: string; value: unknown;
  consentId: ID; origin: 'USER' | 'IMPORTED'; createdAt: ISODate; updatedAt: ISODate;
  deletedAt?: ISODate;
}>;

export type CapabilitySlot = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
export type CapabilityDefinition = Readonly<{
  id: ID; slot: CapabilitySlot; version: number; status: 'UNCONFIGURED' | 'ACTIVE' | 'DISABLED';
  name?: string; purpose?: string; scope: readonly string[]; allowedTools: readonly string[];
  inputSchemaVersion: number; outputSchemaVersion: number; maximumSteps: number;
  maximumToolCalls: number; privacyScopes: readonly string[];
}>;

export type OperationStatus = 'DRAFT' | 'READY' | 'RUNNING' | 'WAITING_APPROVAL' | 'INTERRUPT_REQUESTED' | 'INTERRUPTED' | 'FAILED' | 'COMPLETED' | 'SUPERSEDED';
export type WorkStepStatus = 'PENDING' | 'RUNNING' | 'WAITING_APPROVAL' | 'COMPLETED' | 'FAILED' | 'SKIPPED' | 'INVALIDATED';
export type AttemptStatus = 'PENDING' | 'RUNNING' | 'WAITING_APPROVAL' | 'FAILED' | 'COMPLETED' | 'CANCELLED' | 'UNKNOWN';

export type Goal = Readonly<{ id: ID; operationId: ID; statement: string; constraints: readonly string[]; createdAt: ISODate }>;
export type Operation = Readonly<{
  id: ID; workspaceId: ID; createdBy: ID; goalId: ID; title: string;
  status: OperationStatus; version: number; currentRevisionId?: ID; createdAt: ISODate;
  updatedAt: ISODate; lastActivityAt: ISODate; lastErrorCode?: string;
}>;
export type OperationPlan = Readonly<{ id: ID; operationId: ID; latestRevision: number; createdAt: ISODate }>;
export type PlanRevision = Readonly<{
  id: ID; planId: ID; operationId: ID; revision: number; previousRevisionId?: ID;
  reason: string; createdBy: ID; createdAt: ISODate; status: 'ACTIVE' | 'SUPERSEDED';
}>;
export type WorkStep = Readonly<{
  id: ID; operationId: ID; planRevisionId: ID; ordinal: number; title: string; description: string;
  capabilityId: ID; dependsOn: readonly ID[]; state: WorkStepStatus;
  intent: 'RESEARCH' | 'ANALYZE' | 'VERIFY' | 'EXTERNAL_ACTION'; version: number;
}>;
export type StepAttempt = Readonly<{
  id: ID; workStepId: ID; planRevisionId: ID; operationId: ID;
  sequence: number; priorAttemptId?: ID; state: AttemptStatus; createdAt: ISODate;
  startedAt?: ISODate; finishedAt?: ISODate; errorCode?: string; version: number;
}>;
export type ExecutionLink = Readonly<{
  id: ID; operationId: ID; revisionId: ID; stepAttemptId: ID;
  provider: 'HATCHET' | string; workflowRunId?: string; status: string; observedAt: ISODate;
}>;
export type ApprovalRequest = Readonly<{
  id: ID; operationId: ID; planRevisionId: ID; stepAttemptId: ID; workspaceId: ID;
  purpose: string; toolName?: string; intentId?: ID; status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED';
  requestedAt: ISODate; expiresAt: ISODate; decidedBy?: ID; decidedAt?: ISODate;
}>;
export type ToolInvocationIntent = Readonly<{
  id: ID; operationId: ID; planRevisionId: ID; stepAttemptId: ID; capabilityId: ID;
  toolName: string; toolVersion: string; payload: unknown; idempotencyKey: string;
  mode: 'READ' | 'WRITE'; approvalId?: ID; requestedBy: ID; createdAt: ISODate;
}>;
export type Source = Readonly<{
  id: ID; workspaceId: ID; operationId: ID; uri?: string; provider: string; title: string;
  retrievedAt: ISODate; sourcePublishedAt?: ISODate; fingerprint?: string; trustNotes?: string;
}>;
export type Evidence = Readonly<{
  id: ID; operationId: ID; sourceId?: ID; stepAttemptId: ID; statement: string;
  observedAt: ISODate; status: 'UNVERIFIED' | 'VERIFIED' | 'DISPUTED' | 'STALE';
  limitations: readonly string[]; supersedesEvidenceId?: ID;
}>;
export type Artifact = Readonly<{
  id: ID; workspaceId: ID; operationId: ID; stepAttemptId: ID;
  contentType: string; storageKey: string; sha256?: string; createdAt: ISODate; immutable: true;
}>;
export type ResultVersion = Readonly<{
  id: ID; workspaceId: ID; operationId: ID; revisionId: ID; version: number;
  title: string; summary: string; evidenceIds: readonly ID[]; artifactIds: readonly ID[];
  status: 'DRAFT' | 'DELIVERABLE' | 'SUPERSEDED'; gaps: readonly string[];
  createdAt: ISODate; supersedesResultId?: ID;
}>;
export type EventRecord = Readonly<{
  id: ID; workspaceId: ID; operationId: ID; kind: string; actorId?: ID;
  data: Readonly<Record<string, unknown>>; occurredAt: ISODate; eventVersion: number;
}>;

export const SOUL_ONBOARDING_STEPS = ['WELCOME', 'LANGUAGE', 'CONSENT', 'ACTIVITY', 'OBJECTIVES', 'NEEDS', 'PREFERENCES', 'FIRST_OBJECTIVE', 'DONE'] as const;
export type SoulOnboardingStep = (typeof SOUL_ONBOARDING_STEPS)[number];
export const SOUL_ONBOARDING_STATUSES = ['IN_PROGRESS', 'PAUSED', 'COMPLETED', 'DISMISSED'] as const;
export type SoulOnboardingStatus = (typeof SOUL_ONBOARDING_STATUSES)[number];
/** View-level status: no persisted row yet for this user/workspace. */
export type SoulOnboardingDisplayStatus = SoulOnboardingStatus | 'NOT_STARTED';
export const SOUL_ONBOARDING_CONTENT_STEPS = ['ACTIVITY', 'OBJECTIVES', 'NEEDS', 'PREFERENCES'] as const;
export type SoulOnboardingContentStep = (typeof SOUL_ONBOARDING_CONTENT_STEPS)[number];
export const SOUL_ONBOARDING_FACT_KEYS: Readonly<Record<SoulOnboardingContentStep, string>> = {
  ACTIVITY: 'onboarding.activity',
  OBJECTIVES: 'onboarding.objectives',
  NEEDS: 'onboarding.needs',
  PREFERENCES: 'onboarding.preferences',
};
export const SOUL_FIRST_OBJECTIVE_FACT_KEY = 'onboarding.first_objective';
/** Progress is persisted per user/workspace; no answer content is stored in this record. */
export type SoulOnboardingRecord = Readonly<{
  id: ID; userId: ID; workspaceId: ID; status: SoulOnboardingStatus; step: SoulOnboardingStep;
  locale: 'en' | 'fr'; consentId?: ID; skippedSteps: readonly SoulOnboardingStep[];
  startedAt: ISODate; updatedAt: ISODate; completedAt?: ISODate; dismissedAt?: ISODate;
}>;
export const soulOnboardingStepOrder: readonly SoulOnboardingStep[] = SOUL_ONBOARDING_STEPS;

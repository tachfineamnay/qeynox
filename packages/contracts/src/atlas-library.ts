import { z } from 'zod';

const entityIdSchema = z.string().min(4).max(120).regex(/^[A-Za-z0-9_-]+$/);

const optionalTrimmed = <T extends z.ZodTypeAny>(inner: T) =>
  z.preprocess(value => {
    if (value === undefined || value === null) return undefined;
    if (typeof value === 'string') {
      const trimmed = value.trim();
      return trimmed.length === 0 ? undefined : trimmed;
    }
    return value;
  }, inner.optional());

export const atlasDocumentStateSchema = z.enum(['DRAFT', 'PARTIAL', 'READY_FOR_REVIEW', 'DELIVERABLE']);
export type AtlasDocumentState = z.infer<typeof atlasDocumentStateSchema>;

export const atlasOperationStatusSchema = z.enum([
  'DRAFT',
  'READY',
  'RUNNING',
  'WAITING_APPROVAL',
  'INTERRUPT_REQUESTED',
  'INTERRUPTED',
  'FAILED',
  'COMPLETED',
  'SUPERSEDED',
]);
export type AtlasOperationStatus = z.infer<typeof atlasOperationStatusSchema>;

export const atlasVersionScopeSchema = z.enum(['ALL', 'LATEST', 'PREVIOUS']);
export type AtlasVersionScope = z.infer<typeof atlasVersionScopeSchema>;

export const atlasVerificationPostureSchema = z.enum([
  'VERIFIED_DELIVERABLE',
  'PARTIALLY_VERIFIED',
  'AWAITING_REVIEW',
  'UNVERIFIED',
]);
export type AtlasVerificationPosture = z.infer<typeof atlasVerificationPostureSchema>;

export const atlasFindingClassSchema = z.enum([
  'VERIFIED',
  'AI_INTERPRETATION',
  'UNRESOLVED',
  'AWAITING_ASSESSMENT',
]);
export type AtlasFindingClass = z.infer<typeof atlasFindingClassSchema>;

export const atlasExportFormatSchema = z.enum(['json', 'html', 'pdf']);
export type AtlasExportFormat = z.infer<typeof atlasExportFormatSchema>;

const dateBoundSchema = z
  .string()
  .trim()
  .refine(
    value => /^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isNaN(Date.parse(value)),
    'Must be YYYY-MM-DD or ISO-8601 timestamp',
  );

export const atlasLibraryQuerySchema = z.object({
  q: optionalTrimmed(z.string().min(1).max(200)),
  operationId: optionalTrimmed(entityIdSchema),
  state: optionalTrimmed(atlasDocumentStateSchema),
  operationStatus: optionalTrimmed(atlasOperationStatusSchema),
  versionScope: optionalTrimmed(atlasVersionScopeSchema),
  version: optionalTrimmed(z.coerce.number().int().min(1).max(1000)),
  from: optionalTrimmed(dateBoundSchema),
  to: optionalTrimmed(dateBoundSchema),
  cursor: optionalTrimmed(z.string().min(4).max(400)),
  limit: optionalTrimmed(z.coerce.number().int().min(1).max(50)),
});
export type AtlasLibraryQuery = z.infer<typeof atlasLibraryQuerySchema>;

export const atlasFindingCountsSchema = z.object({
  VERIFIED: z.number().int().nonnegative(),
  UNRESOLVED: z.number().int().nonnegative(),
  AWAITING_ASSESSMENT: z.number().int().nonnegative(),
  AI_INTERPRETATION: z.number().int().nonnegative(),
});
export type AtlasFindingCounts = z.infer<typeof atlasFindingCountsSchema>;

export const atlasProvenanceSummarySchema = z.object({
  citationCount: z.number().int().nonnegative(),
  verifiableCitationCount: z.number().int().nonnegative(),
  providers: z.array(z.string()),
  latestRetrievedAt: z.string().nullable(),
});
export type AtlasProvenanceSummary = z.infer<typeof atlasProvenanceSummarySchema>;

export const atlasLibraryCardSchema = z.object({
  id: entityIdSchema,
  operationId: entityIdSchema,
  operationTitle: z.string(),
  operationStatus: atlasOperationStatusSchema,
  operationLastErrorCode: z.string().nullable(),
  revisionId: entityIdSchema,
  version: z.number().int().positive(),
  latestVersionForOperation: z.number().int().positive(),
  isLatestVersion: z.boolean(),
  latestDocumentId: entityIdSchema,
  previousVersionDocumentId: entityIdSchema.nullable(),
  title: z.string(),
  objective: z.string(),
  status: atlasDocumentStateSchema,
  verdict: z.string(),
  verificationPosture: atlasVerificationPostureSchema,
  deliverable: z.boolean(),
  counts: atlasFindingCountsSchema,
  provenance: atlasProvenanceSummarySchema,
  createdAt: z.string(),
  reviewedAt: z.string().nullable(),
  lastUpdatedAt: z.string(),
  availableExports: z.array(atlasExportFormatSchema),
  pendingExportCount: z.number().int().nonnegative(),
  activeShareCount: z.number().int().nonnegative(),
});
export type AtlasLibraryCard = z.infer<typeof atlasLibraryCardSchema>;

export const atlasFailedOperationSummarySchema = z.object({
  operationId: entityIdSchema,
  title: z.string(),
  status: z.literal('FAILED'),
  lastActivityAt: z.string(),
  lastErrorCode: z.string().nullable(),
  documentCount: z.number().int().nonnegative(),
});
export type AtlasFailedOperationSummary = z.infer<typeof atlasFailedOperationSummarySchema>;

export const atlasMissionFilterOptionSchema = z.object({
  operationId: entityIdSchema,
  title: z.string(),
  status: atlasOperationStatusSchema,
  documentCount: z.number().int().nonnegative(),
  latestVersion: z.number().int().nonnegative(),
});
export type AtlasMissionFilterOption = z.infer<typeof atlasMissionFilterOptionSchema>;

export const atlasLibraryPageSchema = z.object({
  items: z.array(atlasLibraryCardSchema),
  totalCount: z.number().int().nonnegative(),
  workspaceDocumentCount: z.number().int().nonnegative(),
  nextCursor: z.string().nullable(),
  limit: z.number().int().positive(),
  artifactStoreConfigured: z.boolean(),
  canManageShares: z.boolean(),
  missions: z.array(atlasMissionFilterOptionSchema),
  failedOperations: z.array(atlasFailedOperationSummarySchema),
});
export type AtlasLibraryPage = z.infer<typeof atlasLibraryPageSchema>;

export const atlasCitationPayloadSchema = z.object({
  sourceId: z.string(),
  provider: z.string(),
  uri: z.string().optional(),
  retrievedAt: z.string(),
  publishedAt: z.string().optional(),
  fingerprint: z.string().optional(),
});

export const atlasFindingPayloadSchema = z.object({
  claimId: z.string(),
  statement: z.string(),
  status: z.string(),
  sourceIds: z.array(z.string()).default([]),
  attemptId: z.string().optional(),
  limitations: z.array(z.string()),
  citations: z.array(atlasCitationPayloadSchema),
});

export const atlasBusinessPackSchema = z.object({
  pack: z.string(),
  contractKey: z.string(),
  requestFingerprint: z.string().optional(),
  attemptId: z.string().optional(),
});
export type AtlasBusinessPack = z.infer<typeof atlasBusinessPackSchema>;

export const atlasDocumentPayloadSchema = z.object({
  id: entityIdSchema,
  workspaceId: entityIdSchema.optional(),
  operationId: entityIdSchema,
  revisionId: entityIdSchema,
  version: z.number().int().positive(),
  title: z.string(),
  objective: z.string(),
  status: atlasDocumentStateSchema,
  scope: z.array(z.string()),
  findings: z.array(atlasFindingPayloadSchema),
  nextActions: z.array(z.string()),
  limitations: z.array(z.string()),
  unresolved: z.array(z.string()),
  citations: z.array(atlasCitationPayloadSchema),
  createdAt: z.string(),
  priorId: z.string().optional(),
  reviewedBy: z.string().optional(),
  reviewedAt: z.string().optional(),
  /** P09: AI synthesis from a validated business-pack deliverable. Never a finding, never evidence. */
  interpretations: z.array(z.string()).optional(),
  /** P09: identity of the validated business-pack deliverable the document was assembled from. */
  businessPack: atlasBusinessPackSchema.optional(),
});
export type AtlasDocumentPayload = z.infer<typeof atlasDocumentPayloadSchema>;

export const atlasVersionSummarySchema = z.object({
  id: entityIdSchema,
  version: z.number().int().positive(),
  status: atlasDocumentStateSchema,
  title: z.string(),
  createdAt: z.string(),
  reviewedAt: z.string().nullable(),
  isLatestVersion: z.boolean(),
  verificationPosture: atlasVerificationPostureSchema,
  counts: atlasFindingCountsSchema,
  citationCount: z.number().int().nonnegative(),
});
export type AtlasVersionSummary = z.infer<typeof atlasVersionSummarySchema>;

export const atlasFindingBriefSchema = z.object({
  claimId: z.string(),
  statement: z.string(),
  status: z.string(),
  findingClass: atlasFindingClassSchema,
});

export const atlasChangedFindingSchema = z.object({
  claimId: z.string(),
  statement: z.string(),
  fromStatus: z.string(),
  toStatus: z.string(),
  fromClass: atlasFindingClassSchema,
  toClass: atlasFindingClassSchema,
});

export const atlasVersionComparisonSchema = z.object({
  baseDocumentId: entityIdSchema,
  baseVersion: z.number().int().positive(),
  baseStatus: atlasDocumentStateSchema,
  baseCreatedAt: z.string(),
  targetDocumentId: entityIdSchema,
  targetVersion: z.number().int().positive(),
  targetStatus: atlasDocumentStateSchema,
  targetCreatedAt: z.string(),
  statusChanged: z.boolean(),
  verifiedDelta: z.number().int(),
  unresolvedDelta: z.number().int(),
  awaitingDelta: z.number().int(),
  citationDelta: z.number().int(),
  addedFindings: z.array(atlasFindingBriefSchema),
  removedFindings: z.array(atlasFindingBriefSchema),
  changedFindings: z.array(atlasChangedFindingSchema),
  scopeAdded: z.array(z.string()),
  scopeRemoved: z.array(z.string()),
});
export type AtlasVersionComparison = z.infer<typeof atlasVersionComparisonSchema>;

export const atlasArtifactSummarySchema = z.object({
  id: entityIdSchema,
  format: atlasExportFormatSchema,
  contentType: z.string(),
  sha256: z.string(),
  size: z.number().int().nonnegative(),
  state: z.enum(['AVAILABLE', 'PENDING_UPLOAD']),
  createdAt: z.string(),
});
export type AtlasArtifactSummary = z.infer<typeof atlasArtifactSummarySchema>;

export const atlasLibraryDetailSchema = z.object({
  document: atlasDocumentPayloadSchema,
  operation: z.object({
    id: entityIdSchema,
    title: z.string(),
    status: atlasOperationStatusSchema,
    lastActivityAt: z.string(),
    lastErrorCode: z.string().nullable(),
    currentRevisionId: z.string().nullable(),
  }),
  verdict: z.string(),
  verificationPosture: atlasVerificationPostureSchema,
  deliverable: z.boolean(),
  counts: atlasFindingCountsSchema,
  isLatestVersion: z.boolean(),
  latestDocumentId: entityIdSchema,
  previousVersionDocumentId: entityIdSchema.nullable(),
  nextVersionDocumentId: entityIdSchema.nullable(),
  versions: z.array(atlasVersionSummarySchema),
  comparison: atlasVersionComparisonSchema.nullable(),
  artifacts: z.array(atlasArtifactSummarySchema),
  canExportNew: z.boolean(),
  artifactStoreConfigured: z.boolean(),
  canManageShares: z.boolean(),
  activeShareCount: z.number().int().nonnegative(),
});
export type AtlasLibraryDetail = z.infer<typeof atlasLibraryDetailSchema>;

export const createResultShareSchema = z.object({
  label: optionalTrimmed(z.string().min(1).max(120)),
  expiresInHours: z.coerce.number().int().min(1).max(720).default(72),
});
export type CreateResultShareInput = z.infer<typeof createResultShareSchema>;

export const resultShareStateSchema = z.enum(['ACTIVE', 'EXPIRED', 'REVOKED']);
export type ResultShareState = z.infer<typeof resultShareStateSchema>;

export const resultShareSummarySchema = z.object({
  id: entityIdSchema,
  documentId: entityIdSchema,
  operationId: entityIdSchema,
  label: z.string().nullable(),
  state: resultShareStateSchema,
  createdAt: z.string(),
  expiresAt: z.string(),
  revokedAt: z.string().nullable(),
  lastAccessedAt: z.string().nullable(),
  accessCount: z.number().int().nonnegative(),
});
export type ResultShareSummary = z.infer<typeof resultShareSummarySchema>;

export const createdResultShareSchema = z.object({
  share: resultShareSummarySchema,
  token: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
  sharePath: z.string(),
});
export type CreatedResultShare = z.infer<typeof createdResultShareSchema>;

export const sharedAtlasDocumentSchema = z.object({
  id: entityIdSchema,
  version: z.number().int().positive(),
  title: z.string(),
  objective: z.string(),
  status: atlasDocumentStateSchema,
  scope: z.array(z.string()),
  findings: z.array(
    z.object({
      claimId: z.string(),
      statement: z.string(),
      status: z.string(),
      limitations: z.array(z.string()),
      citations: z.array(atlasCitationPayloadSchema),
    }),
  ),
  nextActions: z.array(z.string()),
  limitations: z.array(z.string()),
  unresolved: z.array(z.string()),
  citations: z.array(atlasCitationPayloadSchema),
  createdAt: z.string(),
  reviewedAt: z.string().nullable(),
  hasPriorVersion: z.boolean(),
  interpretations: z.array(z.string()).optional(),
  /** Shared views carry the pack identity only, never internal attempt identifiers. */
  businessPack: atlasBusinessPackSchema.pick({ pack: true, contractKey: true }).optional(),
});
export type SharedAtlasDocument = z.infer<typeof sharedAtlasDocumentSchema>;

export const sharedAtlasResultViewSchema = z.object({
  share: z.object({
    id: entityIdSchema,
    label: z.string().nullable(),
    createdAt: z.string(),
    expiresAt: z.string(),
  }),
  document: sharedAtlasDocumentSchema,
  verdict: z.string(),
  verificationPosture: atlasVerificationPostureSchema,
  deliverable: z.boolean(),
  counts: atlasFindingCountsSchema,
});
export type SharedAtlasResultView = z.infer<typeof sharedAtlasResultViewSchema>;

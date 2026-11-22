import { z } from 'zod';
import {
  SERVICE_CONTRACT_CONTENT_PACK,
  SERVICE_CONTRACT_FINANCIAL_PACK,
  SERVICE_CONTRACT_MARKETING_PACK,
  SERVICE_CONTRACT_OPERATIONS_PACK,
  SERVICE_CONTRACT_RESEARCH_PACK,
  SERVICE_CONTRACT_SALES_PACK,
  SERVICE_CONTRACT_SEO_PACK,
  SERVICE_CONTRACT_STRATEGY_PACK,
  businessPackDomainSchema,
  contentPackRequestSchema,
  financialAnalysisPackRequestSchema,
  marketingPackRequestSchema,
  operationsPackRequestSchema,
  researchPackRequestSchema,
  salesPackRequestSchema,
  seoPackRequestSchema,
  serviceContractMetaSchema,
  strategyPackRequestSchema,
  unavailableExternalConnectorSchema,
} from './business-packs';

const idSchema = z.string().min(4).max(120).regex(/^[A-Za-z0-9_-]+$/);

/**
 * MISSION A13 + A16 — customer service catalogue and typed request contracts.
 *
 * Every field below is either copied verbatim from an operator-published RaaS offer row or computed
 * from the deployment's real configuration and runtime readiness. Nothing in this module fabricates a
 * price, a scope, an availability claim, a provider permission or a delivery promise.
 */

/** The World Bank economic-indicator research contract (A03). Bounded and explicit. */
export const worldBankResearchConstraintsSchema = z.object({
  /** How many of the most recent published observations to read (1–5). */
  mostRecent: z.number().int().min(1).max(5).optional(),
  /** Ignore observations published before this year. */
  minObservationYear: z.number().int().min(1960).max(new Date().getUTCFullYear()).optional(),
  /** At most two additional series, each a dotted World Bank indicator code. */
  compareIndicators: z.array(z.string().trim().min(3).max(64)).max(2).optional(),
  /** Ask for one interpretation step over the captured series. */
  includeInterpretation: z.boolean().optional(),
  /** Free-form note carried into the plan; never interpreted as an instruction. */
  note: z.string().trim().max(500).optional(),
});
export const worldBankResearchRequestSchema = z.object({
  /** The business objective in the customer's words. Required; never generated for the customer. */
  objective: z.string().trim().min(20).max(5000),
  /** ISO 3166-1 alpha-2 or alpha-3 country code. */
  country: z.string().trim().min(2).max(3).regex(/^[A-Za-z]{2,3}$/),
  /** World Bank indicator code, e.g. NY.GDP.PCAP.CD. */
  indicator: z.string().trim().min(3).max(64).regex(/^[A-Za-z0-9]+(?:\.[A-Za-z0-9]+)+$/),
  constraints: worldBankResearchConstraintsSchema.optional(),
});
export type WorldBankResearchRequestInput = z.infer<typeof worldBankResearchRequestSchema>;
export const SERVICE_CONTRACT_WORLD_BANK = 'world-bank-economic-research@1' as const;

/**
 * Wire envelope for POST /v1/services/:offerId/requests and POST /v1/services/:offerId/preview.
 * The `service` discriminator pins the exact contract the customer is ordering; the endpoint
 * refuses an envelope whose discriminator does not match the contract registered for the offer.
 */
export const serviceRequestEnvelopeSchema = z.discriminatedUnion('service', [
  z.object({ service: z.literal(SERVICE_CONTRACT_WORLD_BANK), input: worldBankResearchRequestSchema }),
  z.object({ service: z.literal(SERVICE_CONTRACT_RESEARCH_PACK), input: researchPackRequestSchema }),
  z.object({ service: z.literal(SERVICE_CONTRACT_STRATEGY_PACK), input: strategyPackRequestSchema }),
  z.object({ service: z.literal(SERVICE_CONTRACT_MARKETING_PACK), input: marketingPackRequestSchema }),
  z.object({ service: z.literal(SERVICE_CONTRACT_SEO_PACK), input: seoPackRequestSchema }),
  z.object({ service: z.literal(SERVICE_CONTRACT_SALES_PACK), input: salesPackRequestSchema }),
  z.object({ service: z.literal(SERVICE_CONTRACT_OPERATIONS_PACK), input: operationsPackRequestSchema }),
  z.object({ service: z.literal(SERVICE_CONTRACT_FINANCIAL_PACK), input: financialAnalysisPackRequestSchema }),
  z.object({ service: z.literal(SERVICE_CONTRACT_CONTENT_PACK), input: contentPackRequestSchema }),
]);
export type ServiceRequestEnvelope = z.infer<typeof serviceRequestEnvelopeSchema>;

/** Real, compute-at-read-time availability of one offer's capabilities. */
export const serviceAvailabilitySchema = z.object({
  operationalState: z.enum(['BLOCKED', 'UNVERIFIED', 'CONFIGURED', 'OPERATIONAL']),
  /** True only when every linked capability is OPERATIONAL. */
  isExecutable: z.boolean(),
  /** Stable blocker codes (see docs). Empty when ready. */
  blockers: z.array(z.string()),
});
export type ServiceAvailability = z.infer<typeof serviceAvailabilitySchema>;

export const serviceSummarySchema = z.object({
  offerId: z.string(),
  version: z.number().int().positive(),
  label: z.string(),
  /** Integer minor units; the UI converts. */
  amountMinor: z.number().int().nonnegative(),
  currency: z.string(),
  isExplicitlyFree: z.boolean(),
  /** A zero price without isExplicitlyFree is shown as invalid, never as "free". */
  taxPolicy: z.enum(['CONFIG_REQUIRED', 'CONFIGURED']),
  scope: z.array(z.string()),
  exclusions: z.array(z.string()),
  regions: z.array(z.string()),
  locales: z.array(z.string()),
  termsVersion: z.string(),
  deliverableSchemaVersion: z.number().int().positive(),
  capabilityIds: z.array(z.string()),
  availability: serviceAvailabilitySchema,
  /** True when this deployment registered a typed request contract for the offer's capabilities. */
  requestable: z.boolean(),
  contractKey: z.string().nullable(),
  /** Present only when requestable is false: SERVICE_NOT_CONFIGURED | CAPABILITY_NOT_CONFIGURED. */
  unavailableReason: z.string().nullable(),
  /** Operator-editable business pack domain and specialization (present for A16 packs). */
  packDomain: businessPackDomainSchema.optional(),
  displayName: z.string().optional(),
  specialization: z.string().optional(),
});
export type ServiceSummary = z.infer<typeof serviceSummarySchema>;

export const serviceCapabilitySchema = z.object({
  id: z.string(),
  name: z.string(),
  purpose: z.string(),
  scope: z.array(z.string()),
  maximumSteps: z.number().int().positive(),
  maximumToolCalls: z.number().int().nonnegative(),
  operationalState: z.enum(['BLOCKED', 'UNVERIFIED', 'CONFIGURED', 'OPERATIONAL']),
  providerStatus: z.enum(['BLOCKED', 'CONFIGURED_NOT_LIVE_VERIFIED', 'NOT_REQUIRED']).optional(),
  providerBlockers: z.array(z.object({ tool: z.string(), reason: z.string() })).optional(),
  providerReady: z.boolean(),
  missingProviders: z.array(z.string()),
  profileReady: z.boolean(),
  policyReady: z.boolean(),
  missingPolicies: z.array(z.string()),
  isExecutable: z.boolean(),
});
export type ServiceCapability = z.infer<typeof serviceCapabilitySchema>;

export const serviceDeploymentSchema = z.object({
  worldBankEnabled: z.boolean(),
  egressAttested: z.boolean(),
  braveSearchEnabled: z.boolean().optional(),
  braveSearchKeyConfigured: z.boolean().optional(),
  requiredProvider: z.enum(['world-bank', 'brave-search']).optional(),
  providerSwitchReady: z.boolean().optional(),
  providerStatus: z.enum(['BLOCKED', 'CONFIGURED_NOT_LIVE_VERIFIED']).optional(),
  consentScopesRequired: z.array(z.string()).optional(),
  unavailableExternalConnectors: z.array(unavailableExternalConnectorSchema).optional(),
});
export type ServiceDeployment = z.infer<typeof serviceDeploymentSchema>;

export const serviceDetailSchema = serviceSummarySchema.extend({
  capabilities: z.array(serviceCapabilitySchema),
  /** Deployment switches echoed as booleans only (never values), plus honest blocked connectors. */
  deployment: serviceDeploymentSchema.nullable(),
  /** Operator-editable request constraints and deliverable structure for A16 packs. */
  contractMeta: serviceContractMetaSchema.optional(),
});
export type ServiceDetail = z.infer<typeof serviceDetailSchema>;
export const serviceListSchema = z.array(serviceSummarySchema);

/** POST /v1/services/:offerId/requests — the created operation and plan revision. */
export const serviceRequestResultSchema = z.object({
  operationId: idSchema,
  revisionId: idSchema,
  /** Deterministic digest of the normalized request; what the customer approves. */
  fingerprint: z.string(),
  /** Named caveats the customer should know before approving. */
  warnings: z.array(z.string()),
  stepCount: z.number().int().positive(),
});
export type ServiceRequestResult = z.infer<typeof serviceRequestResultSchema>;

/** POST /v1/services/:offerId/preview — side-effect-free plan preview for a typed service request. */
export const servicePreviewStepSchema = z.object({
  index: z.number().int().nonnegative(),
  title: z.string(),
  description: z.string(),
  capabilityId: z.string(),
  intent: z.enum(['RESEARCH', 'ANALYZE', 'VERIFY', 'EXTERNAL_ACTION']),
  dependsOnIndices: z.array(z.number().int().nonnegative()),
});
export const servicePreviewResultSchema = z.object({
  contractKey: z.string(),
  packDomain: businessPackDomainSchema.nullable(),
  fingerprint: z.string(),
  requiresUserApproval: z.boolean(),
  warnings: z.array(z.string()),
  steps: z.array(servicePreviewStepSchema).min(1),
  computedMetrics: z.record(z.string(), z.unknown()).optional(),
});
export type ServicePreviewResult = z.infer<typeof servicePreviewResultSchema>;

/** Control: read-only validation of a service definition against live configuration. */
export const serviceValidationRequestSchema = z.object({
  workspaceId: z.string().min(4).max(120).regex(/^[A-Za-z0-9_-]+$/),
  capabilityId: idSchema,
  offerId: z.string().min(4).max(120).regex(/^[A-Za-z0-9_.:-]+$/),
  expectedProvider: z.enum(['world-bank', 'brave-search']).default('world-bank'),
});
export const serviceValidationFindingSchema = z.object({
  code: z.string(),
  severity: z.enum(['BLOCKER', 'WARNING']),
  domain: z.enum(['TOOL', 'CAPABILITY', 'PROFILE', 'VERIFICATION', 'OFFER', 'BUDGET']),
  detail: z.string(),
  remedy: z.string(),
});
export const serviceValidationReportSchema = z.object({
  capabilityId: z.string(),
  offerId: z.string(),
  valid: z.boolean(),
  /** Iteration basis: the ACTIVE business profile's maxIterations, or null when none is ACTIVE. */
  maximumIterations: z.number().int().positive().nullable(),
  findings: z.array(serviceValidationFindingSchema),
});
export type ServiceValidationReport = z.infer<typeof serviceValidationReportSchema>;

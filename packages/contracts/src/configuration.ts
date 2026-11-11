import { z } from 'zod';

/**
 * Operator configuration contracts.
 * Every business definition, provider, price and budget ceiling is supplied explicitly by an
 * operator. There are no fallback definitions, providers or prices in code.
 */
export const configurationIdSchema = z.string().trim().min(4).max(120).regex(/^[A-Za-z0-9_-]+$/);
export const connectorIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/);
export const connectorVersionSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/);
/** A broker tool identity: connector:tool@version. */
export const toolRefSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}:[A-Za-z0-9][A-Za-z0-9._-]{0,63}@[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/);
export const budgetProviderKeySchema = z.union([z.literal('hermes'), toolRefSchema]);
export const configurationStatusSchema = z.enum(['ACTIVE', 'DISABLED']);
const isoTimestamp = z.string().refine(value => !Number.isNaN(Date.parse(value)), 'Invalid ISO timestamp');
const currencySchema = z.string().regex(/^[A-Z]{3}$/);

export const capabilityConfigurationSchema = z.object({
  domain: z.literal('BUSINESS_CAPABILITY'),
  slot: z.number().int().min(1).max(8),
  version: z.number().int().min(1).max(1_000_000),
  status: configurationStatusSchema,
  name: z.string().trim().min(2).max(120),
  purpose: z.string().trim().min(10).max(2000),
  scope: z.array(z.string().trim().min(2).max(120)).min(1).max(20),
  allowedTools: z.array(toolRefSchema).max(50),
  privacyScopes: z.array(z.string().trim().min(2).max(80)).max(20),
  inputSchemaVersion: z.number().int().min(1).max(1000),
  outputSchemaVersion: z.number().int().min(1).max(1000),
  maximumSteps: z.number().int().min(1).max(100),
  maximumToolCalls: z.number().int().min(0).max(1000),
}).strict();

const profileFields = {
  version: z.number().int().min(1).max(1_000_000),
  status: configurationStatusSchema,
  title: z.string().trim().min(3).max(120),
  systemInstructions: z.string().trim().min(20).max(20000),
  skillRefs: z.array(z.string().trim().min(2).max(120)).max(20),
  allowedTools: z.array(toolRefSchema).max(50),
  permittedContextKeys: z.array(z.string().regex(/^[a-z][a-z0-9:_-]{1,80}$/)).max(50),
  maxOutputTokens: z.number().int().min(1).max(32768),
  maxIterations: z.number().int().min(1).max(20),
};
export const businessProfileConfigurationSchema = z.object({ domain: z.literal('AGENT_PROFILE'), slot: z.number().int().min(1).max(8), ...profileFields }).strict();
export const soulProfileConfigurationSchema = z.object({ domain: z.literal('SOUL_PROFILE'), ...profileFields }).strict();
export const pilotProfileConfigurationSchema = z.object({ domain: z.literal('PILOT_PROFILE'), ...profileFields }).strict();

export const toolConfigurationSchema = z.object({
  domain: z.literal('TOOL'),
  connectorId: connectorIdSchema,
  version: connectorVersionSchema,
  status: configurationStatusSchema,
  // Values must reference deployment-managed secrets by name; credential material is rejected by strict keys.
  manifest: z.object({
    description: z.string().trim().min(10).max(500),
    provider: z.string().trim().min(2).max(120),
    regions: z.array(z.string().trim().min(2).max(40)).min(1).max(20),
    operations: z.array(z.string().trim().min(2).max(80)).min(1).max(50),
    mode: z.enum(['READ_ONLY', 'SIDE_EFFECTS']),
    licenseNotes: z.string().trim().min(10).max(2000),
    termsUrl: z.string().url().optional(),
    credentialRef: z.string().regex(/^[A-Za-z0-9_.:/-]{1,120}$/).optional(),
    freshness: z.object({ ttlSeconds: z.number().int().min(0).max(31_536_000), publishedAtSource: z.enum(['PROVIDER', 'UNKNOWN']) }).strict(),
    rateLimit: z.object({ maxPerMinute: z.number().int().min(1).max(100_000) }).strict(),
    tools: z.array(z.object({ name: z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,63}$/), version: connectorVersionSchema }).strict()).min(1).max(100),
  }).strict(),
}).strict();

export const verificationPolicyConfigurationSchema = z.object({
  domain: z.literal('VERIFICATION_POLICY'),
  capabilityId: configurationIdSchema,
  version: z.number().int().min(1).max(1_000_000),
  status: configurationStatusSchema,
  minimumSources: z.number().int().min(1).max(10),
  maxAgeDays: z.number().int().min(1).max(3650),
  approvedProviders: z.array(connectorIdSchema).min(1).max(20),
  humanReviewRequired: z.boolean(),
  validFrom: isoTimestamp,
}).strict();

export const offerConfigurationSchema = z.object({
  domain: z.literal('RAAS_OFFER'),
  offerId: configurationIdSchema,
  version: z.number().int().min(1).max(1_000_000),
  status: configurationStatusSchema,
  label: z.string().trim().min(3).max(200),
  capabilityIds: z.array(configurationIdSchema).min(1).max(50),
  deliverableSchemaVersion: z.number().int().min(1).max(1000),
  scope: z.array(z.string().trim().min(2).max(200)).min(1).max(50),
  exclusions: z.array(z.string().trim().min(2).max(200)).max(50),
  regions: z.array(z.string().trim().min(2).max(40)).min(1).max(20),
  locales: z.array(z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/)).min(1).max(20),
  termsVersion: z.string().trim().min(1).max(40),
  currency: currencySchema,
  amountMinor: z.number().int().min(0).max(1_000_000_000_000),
  taxPolicy: z.enum(['CONFIG_REQUIRED', 'CONFIGURED']),
  isExplicitlyFree: z.boolean(),
}).strict();

export const budgetPolicyConfigurationSchema = z.object({
  domain: z.literal('BUDGET_POLICY'),
  policyId: configurationIdSchema,
  version: z.number().int().min(1).max(1_000_000),
  status: configurationStatusSchema,
  currency: currencySchema,
  maxMoneyMinor: z.number().int().min(0).max(1_000_000_000_000),
  maxAgentCalls: z.number().int().min(0).max(1_000_000),
  maxToolCalls: z.number().int().min(0).max(1_000_000),
  maxDurationSeconds: z.number().int().min(1).max(31_536_000),
  maxConcurrent: z.number().int().min(1).max(100),
  unitMaxMinor: z.record(budgetProviderKeySchema, z.number().int().min(0).max(1_000_000_000_000)),
}).strict().refine(policy => Object.keys(policy.unitMaxMinor).length > 0, 'At least one per-provider cost ceiling is required');

export const configurationEntrySchema = z.discriminatedUnion('domain', [
  capabilityConfigurationSchema,
  businessProfileConfigurationSchema,
  soulProfileConfigurationSchema,
  pilotProfileConfigurationSchema,
  toolConfigurationSchema,
  verificationPolicyConfigurationSchema,
  offerConfigurationSchema,
  budgetPolicyConfigurationSchema,
]);

export const applyConfigurationSchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(200).regex(/^[A-Za-z0-9_.:-]+$/),
  dryRun: z.boolean().optional(),
  entries: z.array(configurationEntrySchema).min(1).max(64),
}).strict();

export type ConfigurableDomain = z.infer<typeof configurationEntrySchema>['domain'];
export type ConfigurationEntry = z.infer<typeof configurationEntrySchema>;
export type ApplyConfigurationInput = z.infer<typeof applyConfigurationSchema>;
export const CONFIGURABLE_DOMAINS = [
  'BUSINESS_CAPABILITY', 'AGENT_PROFILE', 'SOUL_PROFILE', 'PILOT_PROFILE',
  'TOOL', 'VERIFICATION_POLICY', 'RAAS_OFFER', 'BUDGET_POLICY',
] as const satisfies readonly ConfigurableDomain[];

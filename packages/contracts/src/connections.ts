import { z } from 'zod';

/**
 * MISSION A14 — connector hub wire contracts.
 *
 * Connection views are workspace-scoped read models. They NEVER carry credential material: the
 * strongest artifact they can hold is opaque metadata (external account id, granted scope names,
 * discovered capability keys, expiry timestamps). Any token leaf is rejected at the contract level.
 */

export const CONNECTION_PROVIDERS = ['google-workspace'] as const;
export type ConnectionProviderId = (typeof CONNECTION_PROVIDERS)[number];

/** What this workspace can see for one reviewed provider. */
export const connectionProviderStateSchema = z.enum([
  /** No deployment-level client credentials — the deployment cannot talk to the provider at all. */
  'NOT_CONFIGURED',
  /** Configured, but no workspace account is connected yet. */
  'CONNECT_REQUIRED',
  /** Connected, scopes granted, token fresh. */
  'CONNECTED',
  /** Connected, but the token is within the renewal window. */
  'EXPIRING_SOON',
  /** Token expired and has not yet been renewed (or could not be). */
  'EXPIRED',
  /** Connected, provider returned a revocation/error signal. */
  'ERROR',
  /** Deliberately disconnected by this workspace. */
  'REVOKED',
]);
export type ConnectionProviderState = z.infer<typeof connectionProviderStateSchema>;

export const connectionViewSchema = z.object({
  provider: z.string(),
  providerVersion: z.string(),
  label: z.string(),
  purpose: z.string(),
  state: connectionProviderStateSchema,
  /** Human detail: why it cannot be used yet (missing client credentials, last provider error code…). */
  reason: z.string().nullable(),
  /** Scopes the provider needs and scopes actually granted. */
  requestedScopes: z.array(z.string()),
  grantedScopes: z.array(z.string()),
  /** Capability keys derived ONLY from granted scopes (provider-declared mapping). */
  capabilities: z.array(z.string()),
  externalAccountId: z.string().nullable(),
  accessTokenExpiresAt: z.string().nullable(),
  lastHealthCheckAt: z.string().nullable(),
  connectedBy: z.string().nullable(),
  connectedAt: z.string().nullable(),
  lastErrorCode: z.string().nullable(),
});
export type ConnectionView = z.infer<typeof connectionViewSchema>;

export const connectionAuthorizationSchema = z.object({
  provider: z.string(),
  /** Where the browser must be sent. Never logged. */
  authorizationUrl: z.string().url(),
  expiresAt: z.string(),
});
export type ConnectionAuthorization = z.infer<typeof connectionAuthorizationSchema>;

export const connectionOperationResultSchema = z.object({
  provider: z.string(),
  state: connectionProviderStateSchema,
  externalAccountId: z.string().nullable(),
});
export type ConnectionOperationResult = z.infer<typeof connectionOperationResultSchema>;

export const connectionAuditEntrySchema = z.object({
  id: z.string(),
  connectionId: z.string().nullable(),
  userId: z.string().nullable(),
  action: z.string(),
  outcome: z.enum(['SUCCESS', 'DENIED', 'FAILED']),
  reason: z.string().nullable(),
  happenedAt: z.string(),
});
export type ConnectionAuditEntry = z.infer<typeof connectionAuditEntrySchema>;
export const connectionAuditListSchema = z.array(connectionAuditEntrySchema);
export type ConnectionAuditList = z.infer<typeof connectionAuditListSchema>;

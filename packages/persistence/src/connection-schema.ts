import { sql } from 'drizzle-orm';
import { pgTable, text, jsonb, timestamp, uniqueIndex, index, customType, check } from 'drizzle-orm/pg-core';
import { identityWorkspaces, identityUsers } from './identity-schema';

/**
 * MISSION A14 — workspace-scoped external account connections.
 *
 * `connectionCredentials` never holds plaintext: it stores AES-256-GCM components only, written and
 * read exclusively by the server-side vault. No API, read model or prompt ever selects it into a
 * payload. `connectionAuditEvents` is the workspace-visible audit trail; it stores action metadata,
 * never credential material.
 */

// node-postgres maps bytea <-> Buffer natively; no conversion needed.
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });

export type ConnectionState = 'PENDING_AUTHORIZATION' | 'ACTIVE' | 'EXPIRED' | 'ERROR' | 'REVOKED';

export const connections = pgTable('connections', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => identityWorkspaces.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull(),
  providerVersion: text('provider_version').notNull(),
  state: text('state').$type<ConnectionState>().notNull().default('PENDING_AUTHORIZATION'),
  externalAccountId: text('external_account_id'),
  scopes: jsonb('scopes').$type<string[]>().notNull().default([]),
  capabilities: jsonb('capabilities').$type<string[]>().notNull().default([]),
  accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
  credentialRef: text('credential_ref'),
  lastErrorCode: text('last_error_code'),
  lastHealthCheckAt: timestamp('last_health_check_at', { withTimezone: true }),
  connectedBy: text('connected_by').notNull(),
  connectedByEmail: text('connected_by_email'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex('connections_workspace_provider_unique').on(t.workspaceId, t.provider),
  index('connections_state_idx').on(t.state, t.updatedAt),
  check('connections_state_check', sql`${t.state} IN ('PENDING_AUTHORIZATION', 'ACTIVE', 'EXPIRED', 'ERROR', 'REVOKED')`),
]);

export const connectionCredentials = pgTable('connection_credentials', {
  credentialRef: text('credential_ref').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => identityWorkspaces.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull(),
  iv: bytea('iv').notNull(),
  authTag: bytea('auth_tag').notNull(),
  ciphertext: bytea('ciphertext').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [index('connection_credentials_workspace_idx').on(t.workspaceId, t.provider)]);

export const oauthAuthorizationStates = pgTable('oauth_authorization_states', {
  id: text('id').primaryKey(),
  stateHash: text('state_hash').notNull().unique(),
  workspaceId: text('workspace_id').notNull().references(() => identityWorkspaces.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => identityUsers.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull(),
  codeVerifier: text('code_verifier').notNull(),
  redirectUri: text('redirect_uri').notNull(),
  state: text('state').$type<'PENDING' | 'CONSUMED'>().notNull().default('PENDING'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  index('oauth_states_expiry_idx').on(t.expiresAt),
  check('oauth_states_state_check', sql`${t.state} IN ('PENDING', 'CONSUMED')`),
]);

export const connectionAuditEvents = pgTable('connection_audit_events', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => identityWorkspaces.id, { onDelete: 'cascade' }),
  connectionId: text('connection_id'),
  userId: text('user_id'),
  action: text('action').notNull(),
  outcome: text('outcome').$type<'SUCCESS' | 'DENIED' | 'FAILED'>().notNull(),
  reason: text('reason'),
  detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  index('connection_audit_workspace_time_idx').on(t.workspaceId, t.createdAt),
  check('connection_audit_outcome_check', sql`${t.outcome} IN ('SUCCESS', 'DENIED', 'FAILED')`),
]);

import { sql } from 'drizzle-orm';
import { pgTable, text, integer, jsonb, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { identityWorkspaces } from './identity-schema';
export type ConfigurationStatus = 'ACTIVE' | 'DISABLED';
const active = sql`status = 'ACTIVE'`;
export const toolConfigurations = pgTable('tool_configurations', {
  id: text('id').primaryKey(),
  connectorId: text('connector_id').notNull(),
  connectorVersion: text('connector_version').notNull(),
  status: text('status').$type<ConfigurationStatus>().notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  digest: text('digest').notNull(),
  configuredBy: text('configured_by').notNull(),
  configuredAt: timestamp('configured_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex('tool_configuration_connector_version_unique').on(t.connectorId, t.connectorVersion),
  uniqueIndex('tool_configuration_active_connector_unique').on(t.connectorId).where(sql`${t.status} = 'ACTIVE'`),
]);
export const budgetPolicies = pgTable('budget_policies', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  version: integer('version').notNull(),
  status: text('status').$type<ConfigurationStatus>().notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  digest: text('digest').notNull(),
  configuredBy: text('configured_by').notNull(),
  configuredAt: timestamp('configured_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex('budget_policy_workspace_key_version_unique').on(t.workspaceId, t.id, t.version),
  uniqueIndex('budget_policy_active_workspace_unique').on(t.workspaceId).where(sql`${t.status} = 'ACTIVE'`),
]);
export const configurationRecords = pgTable('configuration_records', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => identityWorkspaces.id),
  idempotencyKey: text('idempotency_key').notNull(),
  digest: text('digest').notNull(),
  actorId: text('actor_id').notNull(),
  appliedAt: timestamp('applied_at', { withTimezone: true }).notNull().defaultNow(),
  summary: jsonb('summary').$type<Record<string, unknown>>().notNull(),
}, t => [uniqueIndex('configuration_record_workspace_key_unique').on(t.workspaceId, t.idempotencyKey)]);

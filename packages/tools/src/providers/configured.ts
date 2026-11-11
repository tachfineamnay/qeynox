import { eq } from 'drizzle-orm';
import { DomainError, type CapabilityDefinition, type ID } from '@qeynox/domain';
import { capabilities, toolConfigurations, type QeyNoxDatabase } from '@qeynox/persistence';
import { ToolRegistry } from '../registry';
import type { ConnectorManifest } from '../manifest';
import { EgressPolicy, egressPolicyFromEnv } from '../egress';
import { WorldBankConnector, worldBankManifest } from './world-bank';

export interface ProviderEnvironment { readonly worldBankEnabled: boolean; readonly egress: EgressPolicy }
export function providerEnvironmentFromEnv(env: NodeJS.ProcessEnv = process.env): ProviderEnvironment {
  return { worldBankEnabled: env.QEYNOX_WORLD_BANK_ENABLED === 'true', egress: egressPolicyFromEnv(env) };
}
function reviewedManifest(configured: ConnectorManifest | undefined, reviewed: ConnectorManifest, connectorId: string, connectorVersion: string): ConnectorManifest {
  if (!configured) throw new DomainError('INVALID_INPUT', 'Configured connector manifest is missing: ' + connectorId);
  if (configured.id !== connectorId || configured.version !== connectorVersion) throw new DomainError('INVALID_INPUT', 'Configured connector identity does not match the reviewed adapter: ' + connectorId);
  if (configured.mode !== reviewed.mode) throw new DomainError('INVALID_INPUT', 'Configured connector mode does not match the reviewed adapter: ' + connectorId);
  const configuredTools = [...configured.tools].map(tool => tool.name + '@' + tool.version).sort();
  const reviewedTools = [...reviewed.tools].map(tool => tool.name + '@' + tool.version).sort();
  if (configuredTools.join(',') !== reviewedTools.join(',')) throw new DomainError('INVALID_INPUT', 'Configured connector tools do not match the reviewed adapter: ' + connectorId);
  if (!Number.isInteger(configured.rateLimit.maxPerMinute) || configured.rateLimit.maxPerMinute < 1 || configured.rateLimit.maxPerMinute > reviewed.rateLimit.maxPerMinute) {
    throw new DomainError('INVALID_INPUT', 'Configured rate limit must be between 1 and the reviewed adapter ceiling: ' + connectorId);
  }
  if (configured.regions.some(region => !reviewed.regions.includes(region))) throw new DomainError('INVALID_INPUT', 'Configured connector regions exceed the reviewed adapter: ' + connectorId);
  if (configured.operations.some(operation => !reviewed.operations.includes(operation))) throw new DomainError('INVALID_INPUT', 'Configured connector operations exceed the reviewed adapter: ' + connectorId);
  // Operator input may only tighten the reviewed provider declaration; licence terms, freshness
  // and capability descriptions always come from the reviewed adapter, never from configuration.
  return { ...reviewed, rateLimit: { maxPerMinute: configured.rateLimit.maxPerMinute } };
}

/**
 * Builds the ToolRegistry from operator configuration (tool_configurations). No provider is
 * registered without an explicit ACTIVE configuration; configured providers without a reviewed
 * code adapter fail closed. Deployment attestations are still required before any invocation.
 */
export async function createConfiguredToolRegistry(db: QeyNoxDatabase, env: ProviderEnvironment = providerEnvironmentFromEnv()): Promise<ToolRegistry> {
  const registry = new ToolRegistry();
  const configuredRows = await db.select().from(toolConfigurations).where(eq(toolConfigurations.status, 'ACTIVE'));
  if (!configuredRows.length) return registry;
  const capabilityRows = await db.select().from(capabilities).where(eq(capabilities.status, 'ACTIVE'));
  for (const row of configuredRows) {
    if (row.connectorId === 'world-bank') {
      if (!env.worldBankEnabled) throw new DomainError('NOT_CONFIGURED', 'World Bank connector is configured but QEYNOX_WORLD_BANK_ENABLED is not true');
      // A configured provider must have attested egress and an allowlisted host before registration.
      env.egress.assertAllowed(new URL('https://api.worldbank.org/'));
      const payload = row.payload as { manifest?: Omit<ConnectorManifest, 'id' | 'version'> };
      const configuredManifest: ConnectorManifest | undefined = payload.manifest
        ? { ...payload.manifest, id: row.connectorId, version: row.connectorVersion }
        : undefined;
      const manifest = reviewedManifest(configuredManifest, worldBankManifest, row.connectorId, row.connectorVersion);
      const toolRefs = new Set(worldBankManifest.tools.map(tool => row.connectorId + ':' + tool.name + '@' + tool.version));
      const capabilityIds: ID[] = capabilityRows
        .filter(capability => (capability.payload as CapabilityDefinition).allowedTools.some(ref => toolRefs.has(ref)))
        .map(capability => capability.id as ID);
      registry.registerBundle({ manifest, connector: new WorldBankConnector(capabilityIds, env.egress) });
      continue;
    }
    throw new DomainError('NOT_CONFIGURED', 'Configured connector has no reviewed code adapter: ' + row.connectorId);
  }
  return registry;
}



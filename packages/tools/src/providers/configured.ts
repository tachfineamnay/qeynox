import { eq } from 'drizzle-orm';
import { DomainError, type CapabilityDefinition, type DomainErrorCode, type ID } from '@qeynox/domain';
import { capabilities, toolConfigurations, type QeyNoxDatabase } from '@qeynox/persistence';
import { ToolRegistry } from '../registry';
import type { ConnectorManifest } from '../manifest';
import { EgressPolicy, egressPolicyFromEnv } from '../egress';
import { WorldBankConnector, worldBankManifest } from './world-bank';
import { BraveSearchConnector, braveSearchManifest } from './brave-search';

export interface ProviderEnvironment { readonly worldBankEnabled: boolean; readonly braveSearchEnabled: boolean; readonly braveSearchApiKey?: string; readonly egress: EgressPolicy; readonly sharedQuotaConfigured?: boolean }
export function providerEnvironmentFromEnv(env: NodeJS.ProcessEnv = process.env): ProviderEnvironment {
  const braveSearchApiKey = (env.QEYNOX_BRAVE_SEARCH_API_KEY ?? '').trim() || undefined;
  return { worldBankEnabled: env.QEYNOX_WORLD_BANK_ENABLED === 'true', braveSearchEnabled: env.QEYNOX_BRAVE_SEARCH_ENABLED === 'true', braveSearchApiKey, sharedQuotaConfigured: env.NODE_ENV !== 'production' || Boolean(env.QEYNOX_REDIS_URL?.trim()), egress: egressPolicyFromEnv(env) };
}
export interface ProviderRegistrationStatus {
  readonly connectorId: string;
  readonly version: string;
  readonly state: 'BLOCKED' | 'CONFIGURED_NOT_LIVE_VERIFIED';
  readonly reason: string | null;
  readonly errorCode?: DomainErrorCode;
  readonly tools: readonly string[];
  readonly credentialConfigured: boolean;
}
// A16 shipped these exact operation labels. Accept ONLY these aliases; do not widen the tool surface
// or rewrite immutable configuration rows just to migrate declaration vocabulary.
const operationAlias: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'world-bank': { 'indicator.read': 'INDICATOR_RESEARCH' },
  'brave-search': { 'web.search': 'WEB_RESEARCH' },
};
function reviewedManifest(configured: ConnectorManifest | undefined, reviewed: ConnectorManifest, connectorId: string, connectorVersion: string): ConnectorManifest {
  if (!configured || configured.id !== connectorId || configured.version !== reviewed.version || connectorVersion !== reviewed.version) throw new DomainError('INVALID_INPUT', 'Configured connector identity or manifest is invalid');
  if (configured.mode !== reviewed.mode) throw new DomainError('INVALID_INPUT', 'Configured connector mode does not match the reviewed adapter');
  const configuredTools = [...configured.tools].map(tool => tool.name + '@' + tool.version).sort();
  const reviewedTools = [...reviewed.tools].map(tool => tool.name + '@' + tool.version).sort();
  if (configuredTools.join(',') !== reviewedTools.join(',')) throw new DomainError('INVALID_INPUT', 'Configured tools do not match the reviewed adapter');
  if (!Number.isInteger(configured.rateLimit.maxPerMinute) || configured.rateLimit.maxPerMinute < 1 || configured.rateLimit.maxPerMinute > reviewed.rateLimit.maxPerMinute) throw new DomainError('INVALID_INPUT', 'Configured rate limit exceeds the reviewed adapter ceiling');
  const operations = configured.operations.map(operation => operationAlias[connectorId]?.[operation] ?? operation);
  if (!configured.regions.length || configured.regions.some(region => !reviewed.regions.includes(region)) || !operations.length || operations.some(operation => !reviewed.operations.includes(operation))) throw new DomainError('INVALID_INPUT', 'Configured regions or operations exceed the reviewed adapter');
  if (configured.credentialRef && configured.credentialRef !== (connectorId === 'brave-search' ? 'env:QEYNOX_BRAVE_SEARCH_API_KEY' : undefined)) throw new DomainError('INVALID_INPUT', 'Unsupported credential reference');
  // Credential resolution is explicit, never an arbitrary env/file/vault lookup supplied by a row.
  // Descriptions/licensing/freshness come from reviewed code, limits can only tighten it.
  return { ...reviewed, regions: configured.regions, operations, rateLimit: { maxPerMinute: configured.rateLimit.maxPerMinute } };
}

/** Configuration-only resolution: no DNS, credential verification or provider call. */
export async function resolveConfiguredProviders(db: QeyNoxDatabase, env: ProviderEnvironment = providerEnvironmentFromEnv()) {
  const registry = new ToolRegistry();
  const [rows, capabilityRows] = await Promise.all([
    db.select().from(toolConfigurations).where(eq(toolConfigurations.status, 'ACTIVE')),
    db.select().from(capabilities).where(eq(capabilities.status, 'ACTIVE')),
  ]);
  const providers: ProviderRegistrationStatus[] = [];
  for (const row of rows) {
    let reason = 'NO_REVIEWED_ADAPTER';
    const credentialConfigured = row.connectorId === 'world-bank' || (row.connectorId === 'brave-search' && Boolean(env.braveSearchApiKey));
    try {
      const reviewed = row.connectorId === 'world-bank' ? worldBankManifest : row.connectorId === 'brave-search' ? braveSearchManifest : undefined;
      if (!reviewed) throw new DomainError('NOT_CONFIGURED', 'No reviewed adapter');
      reason = 'DEPLOYMENT_SWITCH_DISABLED';
      if (!(row.connectorId === 'world-bank' ? env.worldBankEnabled : env.braveSearchEnabled)) throw new DomainError('NOT_CONFIGURED', 'Provider disabled');
      reason = 'CREDENTIAL_MISSING';
      if (!credentialConfigured) throw new DomainError('NOT_CONFIGURED', 'Provider credential absent');
      reason = 'EGRESS_NOT_ATTESTED';
      if (!env.egress.attested) throw new DomainError('NOT_CONFIGURED', 'Egress not attested');
      reason = 'EGRESS_HOST_NOT_ALLOWED';
      env.egress.assertAllowed(new URL(row.connectorId === 'world-bank' ? 'https://api.worldbank.org/' : 'https://api.search.brave.com/'));
      reason = 'SHARED_QUOTA_NOT_CONFIGURED';
      if (env.sharedQuotaConfigured === false) throw new DomainError('NOT_CONFIGURED', 'Shared provider quota is required');
      reason = 'INVALID_REVIEWED_MANIFEST';
      const payload = row.payload as { manifest?: Omit<ConnectorManifest, 'id' | 'version'> };
      const manifest = reviewedManifest(payload.manifest ? { ...payload.manifest, id: row.connectorId, version: row.connectorVersion } : undefined, reviewed, row.connectorId, row.connectorVersion);
      const toolRefs = manifest.tools.map(tool => row.connectorId + ':' + tool.name + '@' + tool.version);
      const capabilityIds: ID[] = capabilityRows.filter(capability => {
        const definition = capability.payload as CapabilityDefinition;
        return Array.isArray(definition.allowedTools) && definition.allowedTools.some(ref => toolRefs.includes(ref));
      }).map(capability => capability.id as ID);
      registry.registerBundle({ manifest, connector: row.connectorId === 'world-bank'
        ? new WorldBankConnector(capabilityIds, env.egress)
        : new BraveSearchConnector(capabilityIds, env.egress, env.braveSearchApiKey!) });
      providers.push({ connectorId: row.connectorId, version: row.connectorVersion, state: 'CONFIGURED_NOT_LIVE_VERIFIED', reason: null, tools: toolRefs, credentialConfigured });
    } catch (error) {
      providers.push({ connectorId: row.connectorId, version: row.connectorVersion, state: 'BLOCKED', reason, errorCode: error instanceof DomainError ? error.code : 'INVALID_INPUT', tools: [], credentialConfigured });
    }
  }
  for (const reviewed of [worldBankManifest, braveSearchManifest]) if (!rows.some(row => row.connectorId === reviewed.id)) {
    providers.push({ connectorId: reviewed.id, version: reviewed.version, state: 'BLOCKED', reason: 'NO_ACTIVE_TOOL_CONFIGURATION', tools: [], credentialConfigured: reviewed.id === 'world-bank' || Boolean(env.braveSearchApiKey) });
  }
  return { registry, providers };
}

/** Strict compatibility entrypoint: an explicitly ACTIVE but invalid provider still throws. */
export async function createConfiguredToolRegistry(db: QeyNoxDatabase, env: ProviderEnvironment = providerEnvironmentFromEnv()): Promise<ToolRegistry> {
  const result = await resolveConfiguredProviders(db, env);
  const blocked = result.providers.find(provider => provider.state === 'BLOCKED' && provider.reason !== 'NO_ACTIVE_TOOL_CONFIGURATION');
  if (blocked) throw new DomainError(blocked.errorCode ?? 'NOT_CONFIGURED', 'Provider registration blocked: ' + blocked.reason);
  return result.registry;
}

/** Runtime uses partial resolution: a blocked connector never disables unrelated reviewed tools. */
export async function createRuntimeToolRegistry(db: QeyNoxDatabase): Promise<ToolRegistry> {
  return (await resolveConfiguredProviders(db)).registry;
}

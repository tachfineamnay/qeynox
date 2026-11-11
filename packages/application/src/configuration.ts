import { createHash, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { DomainError, type CapabilityDefinition, type CapabilitySlot, type ID, type Principal } from '@qeynox/domain';
import type { AgentProfile } from '@qeynox/engine';
import {
  applyConfigurationSchema,
  type ApplyConfigurationInput,
  type ConfigurationEntry,
} from '@qeynox/contracts';
import {
  QeyNoxStore,
  agentProfiles,
  budgetPolicies,
  capabilities,
  configurationRecords,
  identityWorkspaces,
  offers,
  toolConfigurations,
  verificationPolicies,
  type ConfigurationStatus,
  type QeyNoxDatabase,
} from '@qeynox/persistence';

type Transaction = Parameters<Parameters<QeyNoxDatabase['transaction']>[0]>[0];
export type ConfigurationChangeOutcome = 'CREATE' | 'UNCHANGED' | 'ACTIVATE' | 'DEACTIVATE';
export interface ConfigurationChange {
  readonly domain: ConfigurationEntry['domain'];
  readonly key: string;
  readonly version: number | string;
  readonly outcome: ConfigurationChangeOutcome;
}
export interface ConfigurationApplyResult {
  readonly dryRun: boolean;
  readonly idempotencyKey: string;
  readonly digest: string;
  readonly alreadyApplied: boolean;
  readonly changes: readonly ConfigurationChange[];
}
export interface ConfigurationState {
  readonly capabilities: readonly { slot: number; status: 'ACTIVE' | 'UNCONFIGURED'; capabilityId?: string; version?: number; name?: string }[];
  readonly profiles: readonly { roleKey: string; status: 'ACTIVE' | 'UNCONFIGURED'; profileId?: string; version?: number }[];
  readonly tools: readonly { connectorId: string; version: string; status: ConfigurationStatus }[];
  readonly verificationPolicies: readonly { capabilityId: string; version: number; status: ConfigurationStatus; minimumSources: number; approvedProviders: readonly string[] }[];
  readonly offers: readonly { offerId: string; version: number; status: ConfigurationStatus; currency: string; amountMinor: number; isExplicitlyFree: boolean }[];
  readonly budgetPolicies: readonly { policyId: string; version: number; status: ConfigurationStatus; currency: string; maxMoneyMinor: number; providers: readonly string[] }[];
}

const operatorRoles = ['OWNER', 'ADMIN', 'OPERATOR'] as const;
const capabilitySlots = [1, 2, 3, 4, 5, 6, 7, 8] as const;
const profileRoleKeys = ['soul', 'pilot', ...capabilitySlots.map(slot => 'business:' + slot)] as const;
const configurationRecordSummaryLimit = 40;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(item => canonical(item)).join(',') + ']';
  const record = value as Record<string, unknown>;
  return '{' + Object.keys(record).sort().map(key => JSON.stringify(key) + ':' + canonical(record[key])).join(',') + '}';
}
function contentDigest(value: unknown): string {
  return sha256(canonical(value));
}
function withoutStatus(entry: ConfigurationEntry): Record<string, unknown> {
  const { status: _status, ...rest } = entry;
  return rest as unknown as Record<string, unknown>;
}
function capabilityDigest(definition: CapabilityDefinition): string {
  const { status: _status, ...content } = definition;
  return contentDigest(content);
}
function verificationDigest(value: { capabilityId: string; version: number; minimumSources: number; maxAgeDays: number; approvedProviders: readonly string[]; humanReviewRequired: string; validFrom: string }): string {
  return contentDigest(value);
}
function offerDigest(value: { currency: string; amountMinor: number; configuration: unknown }): string {
  const configuration = value.configuration && typeof value.configuration === 'object'
    ? (() => { const { status: _status, ...rest } = value.configuration as Record<string, unknown>; return rest; })()
    : value.configuration;
  return contentDigest({ currency: value.currency, amountMinor: value.amountMinor, configuration });
}
function operatorAllowlist(): readonly string[] {
  return (process.env.QEYNOX_OPERATOR_USER_IDS ?? '').split(',').map(value => value.trim()).filter(Boolean);
}

interface EntryIdentity { readonly key: string; readonly activeScope: string; readonly rowId: string }
function identityOf(entry: ConfigurationEntry): EntryIdentity {
  switch (entry.domain) {
    case 'BUSINESS_CAPABILITY':
      return { key: 'capability:slot:' + entry.slot, activeScope: 'capability:slot:' + entry.slot, rowId: 'capability-slot-' + entry.slot + '-v' + entry.version };
    case 'AGENT_PROFILE':
      return { key: 'business:' + entry.slot, activeScope: 'business:' + entry.slot, rowId: 'profile-business-' + entry.slot + '-v' + entry.version };
    case 'SOUL_PROFILE':
      return { key: 'soul', activeScope: 'soul', rowId: 'profile-soul-v' + entry.version };
    case 'PILOT_PROFILE':
      return { key: 'pilot', activeScope: 'pilot', rowId: 'profile-pilot-v' + entry.version };
    case 'TOOL':
      return { key: entry.connectorId + '@' + entry.version, activeScope: 'tool:' + entry.connectorId, rowId: 'tool-' + entry.connectorId + '-v' + entry.version.replace(/\./g, '_') };
    case 'VERIFICATION_POLICY':
      return { key: entry.capabilityId + '@' + entry.version, activeScope: 'verification:' + entry.capabilityId, rowId: 'verification-' + entry.capabilityId + '-v' + entry.version };
    case 'RAAS_OFFER':
      return { key: entry.offerId + '@' + entry.version, activeScope: 'offer:' + entry.offerId, rowId: entry.offerId };
    case 'BUDGET_POLICY':
      return { key: entry.policyId + '@' + entry.version, activeScope: 'budget:workspace', rowId: 'budget-' + entry.policyId + '-v' + entry.version };
  }
}
function profileRole(entry: ConfigurationEntry & { domain: 'AGENT_PROFILE' | 'SOUL_PROFILE' | 'PILOT_PROFILE' }): { role: 'business' | 'soul' | 'pilot'; roleKey: string } {
  if (entry.domain === 'SOUL_PROFILE') return { role: 'soul', roleKey: 'soul' };
  if (entry.domain === 'PILOT_PROFILE') return { role: 'pilot', roleKey: 'pilot' };
  return { role: 'business', roleKey: 'business:' + entry.slot };
}
function capabilityIdFor(slot: number, version: number): string {
  return 'capability-slot-' + slot + '-v' + version;
}
function toolRefsOf(manifest: { tools?: readonly { name: string; version: string }[] }, connectorId: string): readonly string[] {
  return (manifest.tools ?? []).map(tool => connectorId + ':' + tool.name + '@' + tool.version);
}

interface ValidationContext {
  readonly enabledToolRefs: ReadonlySet<string>;
  readonly enabledConnectorIds: ReadonlySet<string>;
  readonly activeCapabilityIds: ReadonlySet<string>;
}

export class ConfigurationService {
  constructor(private readonly store: QeyNoxStore) {}

  private requireOperator(actor: Principal): void {
    const allowlist = operatorAllowlist();
    if (!allowlist.length) throw new DomainError('NOT_CONFIGURED', 'Operator configuration is disabled: QEYNOX_OPERATOR_USER_IDS is not set');
    if (!allowlist.includes(actor.userId)) throw new DomainError('DENIED', 'Account is not an allowlisted operator');
    if (!actor.roles.some(role => (operatorRoles as readonly string[]).includes(role))) throw new DomainError('DENIED', 'Workspace operator role required');
  }

  private assertWorkspace(actor: Principal): void {
    if (!actor.workspaceId || !actor.userId) throw new DomainError('DENIED', 'Authenticated workspace required');
  }

  async state(actor: Principal): Promise<ConfigurationState> {
    this.requireOperator(actor);
    this.assertWorkspace(actor);
    const [capabilityRows, profileRows, toolRows, policyRows, offerRows, budgetRows] = await Promise.all([
      this.store.db.select().from(capabilities),
      this.store.db.select().from(agentProfiles),
      this.store.db.select().from(toolConfigurations),
      this.store.db.select().from(verificationPolicies),
      this.store.db.select().from(offers),
      this.store.db.select().from(budgetPolicies).where(eq(budgetPolicies.workspaceId, actor.workspaceId)),
    ]);
    const activeCapabilities = new Map(capabilityRows.filter(row => row.status === 'ACTIVE').map(row => [row.slot, row]));
    const activeProfiles = new Map(profileRows.filter(row => row.active).map(row => [row.roleKey, row]));
    return {
      capabilities: capabilitySlots.map(slot => {
        const row = activeCapabilities.get(slot);
        return row
          ? { slot, status: 'ACTIVE' as const, capabilityId: row.id, version: row.version, name: (row.payload as CapabilityDefinition).name }
          : { slot, status: 'UNCONFIGURED' as const };
      }),
      profiles: profileRoleKeys.map(roleKey => {
        const row = activeProfiles.get(roleKey);
        return row
          ? { roleKey, status: 'ACTIVE' as const, profileId: row.id, version: row.version }
          : { roleKey, status: 'UNCONFIGURED' as const };
      }),
      tools: toolRows.map(row => ({ connectorId: row.connectorId, version: row.connectorVersion, status: row.status })),
      verificationPolicies: policyRows.map(row => ({
        capabilityId: row.capabilityId, version: row.version, status: row.status,
        minimumSources: row.minimumSources, approvedProviders: row.approvedProviders,
      })),
      offers: offerRows.map(row => {
        const configuration = row.configuration as { isExplicitlyFree?: boolean };
        return { offerId: row.id, version: row.version, status: row.status as ConfigurationStatus, currency: row.currency, amountMinor: row.amountMinor, isExplicitlyFree: configuration.isExplicitlyFree === true };
      }),
      budgetPolicies: budgetRows.map(row => {
        const policy = row.payload as { policyId?: string; currency?: string; maxMoneyMinor?: number; unitMaxMinor?: Record<string, number> };
        return { policyId: policy.policyId ?? row.id, version: row.version, status: row.status as ConfigurationStatus, currency: policy.currency ?? '', maxMoneyMinor: policy.maxMoneyMinor ?? 0, providers: Object.keys(policy.unitMaxMinor ?? {}) };
      }),
    };
  }

  async apply(actor: Principal, input: ApplyConfigurationInput | unknown): Promise<ConfigurationApplyResult> {
    this.requireOperator(actor);
    this.assertWorkspace(actor);
    const request = applyConfigurationSchema.parse(input);
    const entries = [...request.entries].sort((a, b) => {
      const left = identityOf(a), right = identityOf(b);
      return (left.key + '@' + a.version).localeCompare(right.key + '@' + b.version);
    });
    this.validateBundleShape(entries);
    const digest = contentDigest(entries);
    try {
      return await this.store.db.transaction(async tx => {
        const [record] = await tx.select().from(configurationRecords)
          .where(and(eq(configurationRecords.workspaceId, actor.workspaceId), eq(configurationRecords.idempotencyKey, request.idempotencyKey))).limit(1);
        if (record) {
          if (record.digest !== digest) throw new DomainError('CONFLICT', 'Idempotency key already used for a different configuration');
          const summary = record.summary as { changes?: readonly ConfigurationChange[] };
          return { dryRun: request.dryRun === true, idempotencyKey: request.idempotencyKey, digest, alreadyApplied: true, changes: summary.changes ?? [] };
        }
        const context = await this.loadContext(tx, entries);
        this.validateEntries(entries, context);
        const changes: ConfigurationChange[] = [];
        for (const entry of entries) changes.push(await this.applyEntry(tx, actor, entry, request.dryRun === true));
        if (request.dryRun !== true) {
          await tx.insert(configurationRecords).values({
            id: randomUUID(), workspaceId: actor.workspaceId, idempotencyKey: request.idempotencyKey,
            digest, actorId: actor.userId, summary: { changes: changes.slice(0, configurationRecordSummaryLimit) },
          });
        }
        return { dryRun: request.dryRun === true, idempotencyKey: request.idempotencyKey, digest, alreadyApplied: false, changes };
      });
    } catch (error: unknown) {
      if (error instanceof DomainError) throw error;
      const code = (error as { code?: string }).code;
      if (code === '23505') throw new DomainError('CONFLICT', 'Configuration version conflicts with an existing record');
      if (code === '23503') throw new DomainError('INVALID_INPUT', 'Configuration references a missing record');
      if (code === '23514') throw new DomainError('INVALID_INPUT', 'Configuration violates an integrity constraint');
      if (code === '23502') throw new DomainError('INVALID_INPUT', 'Configuration is incomplete');
      throw error;
    }
  }

  private validateBundleShape(entries: readonly ConfigurationEntry[]): void {
    const rowIds = new Set<string>();
    const activeScopes = new Set<string>();
    for (const entry of entries) {
      const identity = identityOf(entry);
      const rowId = identity.rowId;
      if (rowIds.has(entry.domain + ':' + rowId)) throw new DomainError('INVALID_INPUT', 'Duplicate configuration entry for ' + identity.key);
      rowIds.add(entry.domain + ':' + rowId);
      if (entry.status === 'ACTIVE') {
        const scope = entry.domain + ':' + identity.activeScope;
        if (activeScopes.has(scope)) throw new DomainError('INVALID_INPUT', 'Only one ACTIVE version may be configured per key: ' + identity.key);
        activeScopes.add(scope);
      }
    }
  }

  private async loadContext(tx: Transaction, entries: readonly ConfigurationEntry[]): Promise<ValidationContext> {
    const [toolRows, capabilityRows] = await Promise.all([
      tx.select().from(toolConfigurations).where(eq(toolConfigurations.status, 'ACTIVE')),
      tx.select().from(capabilities).where(eq(capabilities.status, 'ACTIVE')),
    ]);
    const enabledToolRefs = new Set<string>();
    const enabledConnectorIds = new Set<string>();
    for (const row of toolRows) {
      enabledConnectorIds.add(row.connectorId);
      const manifest = (row.payload as { manifest?: { tools?: readonly { name: string; version: string }[] } }).manifest;
      for (const ref of toolRefsOf(manifest ?? {}, row.connectorId)) enabledToolRefs.add(ref);
    }
    const activeCapabilityIds = new Set(capabilityRows.map(row => row.id));
    for (const entry of entries) {
      if (entry.status !== 'ACTIVE') continue;
      if (entry.domain === 'TOOL') {
        enabledConnectorIds.add(entry.connectorId);
        for (const ref of toolRefsOf(entry.manifest, entry.connectorId)) enabledToolRefs.add(ref);
      }
      if (entry.domain === 'BUSINESS_CAPABILITY') activeCapabilityIds.add(capabilityIdFor(entry.slot, entry.version));
    }
    return { enabledToolRefs, enabledConnectorIds, activeCapabilityIds };
  }

  private validateEntries(entries: readonly ConfigurationEntry[], context: ValidationContext): void {
    for (const entry of entries) {
      switch (entry.domain) {
        case 'BUSINESS_CAPABILITY':
        case 'AGENT_PROFILE':
        case 'SOUL_PROFILE':
        case 'PILOT_PROFILE':
          for (const ref of entry.allowedTools) {
            if (!context.enabledToolRefs.has(ref)) throw new DomainError('INVALID_INPUT', 'Tool is not enabled by operator configuration: ' + ref);
          }
          break;
        case 'TOOL':
          break;
        case 'VERIFICATION_POLICY':
          if (!context.activeCapabilityIds.has(entry.capabilityId)) throw new DomainError('NOT_CONFIGURED', 'Verification policy capability is not active: ' + entry.capabilityId);
          for (const provider of entry.approvedProviders) {
            if (!context.enabledConnectorIds.has(provider)) throw new DomainError('INVALID_INPUT', 'Verification provider has no enabled tool configuration: ' + provider);
          }
          break;
        case 'RAAS_OFFER':
          for (const capabilityId of entry.capabilityIds) {
            if (!context.activeCapabilityIds.has(capabilityId)) throw new DomainError('NOT_CONFIGURED', 'Offer capability is not active: ' + capabilityId);
          }
          if (entry.amountMinor === 0 && !entry.isExplicitlyFree) throw new DomainError('INVALID_INPUT', 'A zero amount requires isExplicitlyFree=true; prices are never invented');
          if (entry.status === 'ACTIVE' && entry.taxPolicy !== 'CONFIGURED') throw new DomainError('NOT_CONFIGURED', 'Offer tax treatment must be explicitly configured before activation');
          break;
        case 'BUDGET_POLICY':
          for (const providerKey of Object.keys(entry.unitMaxMinor)) {
            if (providerKey !== 'hermes' && !context.enabledToolRefs.has(providerKey)) {
              throw new DomainError('INVALID_INPUT', 'Budget rate card references a tool that is not enabled: ' + providerKey);
            }
          }
          break;
      }
    }
  }

  private async applyEntry(tx: Transaction, actor: Principal, entry: ConfigurationEntry, dryRun: boolean): Promise<ConfigurationChange> {
    switch (entry.domain) {
      case 'BUSINESS_CAPABILITY': return this.applyCapability(tx, entry, dryRun);
      case 'AGENT_PROFILE':
      case 'SOUL_PROFILE':
      case 'PILOT_PROFILE': return this.applyProfile(tx, entry, dryRun);
      case 'TOOL': return this.applyTool(tx, actor, entry, dryRun);
      case 'VERIFICATION_POLICY': return this.applyVerificationPolicy(tx, entry, dryRun);
      case 'RAAS_OFFER': return this.applyOffer(tx, entry, dryRun);
      case 'BUDGET_POLICY': return this.applyBudgetPolicy(tx, actor, entry, dryRun);
    }
  }

  private change(entry: ConfigurationEntry, outcome: ConfigurationChangeOutcome): ConfigurationChange {
    return { domain: entry.domain, key: identityOf(entry).key, version: entry.version, outcome };
  }

  private async applyCapability(tx: Transaction, entry: ConfigurationEntry & { domain: 'BUSINESS_CAPABILITY' }, dryRun: boolean): Promise<ConfigurationChange> {
    const rowId = identityOf(entry).rowId;
    const definition: CapabilityDefinition = {
      id: rowId as ID, slot: entry.slot as CapabilitySlot, version: entry.version, status: entry.status,
      name: entry.name, purpose: entry.purpose, scope: entry.scope, allowedTools: entry.allowedTools,
      inputSchemaVersion: entry.inputSchemaVersion, outputSchemaVersion: entry.outputSchemaVersion,
      maximumSteps: entry.maximumSteps, maximumToolCalls: entry.maximumToolCalls, privacyScopes: entry.privacyScopes,
    };
    const [existing] = await tx.select().from(capabilities).where(eq(capabilities.id, rowId)).limit(1);
    if (!existing) {
      if (dryRun) return this.change(entry, 'CREATE');
      if (entry.status === 'ACTIVE') await this.deactivateCapabilities(tx, entry.slot);
      await tx.insert(capabilities).values({ id: rowId, slot: entry.slot, version: entry.version, status: entry.status, payload: definition });
      return this.change(entry, 'CREATE');
    }
    if (capabilityDigest(existing.payload) !== capabilityDigest(definition)) throw new DomainError('CONFLICT', 'Capability version content is immutable: slot ' + entry.slot + ' v' + entry.version);
    if (existing.status === entry.status) return this.change(entry, 'UNCHANGED');
    if (dryRun) return this.change(entry, entry.status === 'ACTIVE' ? 'ACTIVATE' : 'DEACTIVATE');
    if (entry.status === 'ACTIVE') await this.deactivateCapabilities(tx, entry.slot);
    await tx.update(capabilities).set({ status: entry.status, payload: definition }).where(eq(capabilities.id, rowId));
    return this.change(entry, entry.status === 'ACTIVE' ? 'ACTIVATE' : 'DEACTIVATE');
  }
  private async deactivateCapabilities(tx: Transaction, slot: number): Promise<void> {
    await tx.update(capabilities)
      .set({ status: 'DISABLED', payload: sql`${capabilities.payload} || '{"status":"DISABLED"}'::jsonb` })
      .where(and(eq(capabilities.slot, slot), eq(capabilities.status, 'ACTIVE')));
  }

  private async applyProfile(tx: Transaction, entry: ConfigurationEntry & { domain: 'AGENT_PROFILE' | 'SOUL_PROFILE' | 'PILOT_PROFILE' }, dryRun: boolean): Promise<ConfigurationChange> {
    const { role, roleKey } = profileRole(entry);
    const rowId = identityOf(entry).rowId;
    const profile: AgentProfile = {
      id: rowId as ID, role, version: entry.version, title: entry.title, systemInstructions: entry.systemInstructions,
      skillRefs: entry.skillRefs, allowedTools: entry.allowedTools, permittedContextKeys: entry.permittedContextKeys,
      maxOutputTokens: entry.maxOutputTokens, maxIterations: entry.maxIterations,
    };
    const [existing] = await tx.select().from(agentProfiles).where(eq(agentProfiles.id, rowId)).limit(1);
    const active = entry.status === 'ACTIVE';
    if (!existing) {
      if (dryRun) return this.change(entry, 'CREATE');
      if (active) await this.deactivateProfiles(tx, roleKey);
      await tx.insert(agentProfiles).values({ id: rowId, roleKey, version: entry.version, active, payload: profile as unknown as Record<string, unknown> });
      return this.change(entry, 'CREATE');
    }
    if (canonical(existing.payload) !== canonical(profile)) throw new DomainError('CONFLICT', 'Agent profile version content is immutable: ' + roleKey + ' v' + entry.version);
    if (existing.active === active) return this.change(entry, 'UNCHANGED');
    if (dryRun) return this.change(entry, active ? 'ACTIVATE' : 'DEACTIVATE');
    if (active) await this.deactivateProfiles(tx, roleKey);
    await tx.update(agentProfiles).set({ active, payload: profile as unknown as Record<string, unknown> }).where(eq(agentProfiles.id, rowId));
    return this.change(entry, active ? 'ACTIVATE' : 'DEACTIVATE');
  }
  private async deactivateProfiles(tx: Transaction, roleKey: string): Promise<void> {
    await tx.update(agentProfiles).set({ active: false }).where(and(eq(agentProfiles.roleKey, roleKey), eq(agentProfiles.active, true)));
  }

  private async applyTool(tx: Transaction, actor: Principal, entry: ConfigurationEntry & { domain: 'TOOL' }, dryRun: boolean): Promise<ConfigurationChange> {
    const rowId = identityOf(entry).rowId;
    const payload = withoutStatus(entry);
    const digest = contentDigest(payload);
    const [existing] = await tx.select().from(toolConfigurations).where(eq(toolConfigurations.id, rowId)).limit(1);
    if (!existing) {
      if (dryRun) return this.change(entry, 'CREATE');
      if (entry.status === 'ACTIVE') await this.deactivateTools(tx, entry.connectorId);
      await tx.insert(toolConfigurations).values({
        id: rowId, connectorId: entry.connectorId, connectorVersion: entry.version, status: entry.status,
        payload, digest, configuredBy: actor.userId, updatedAt: new Date(),
      });
      return this.change(entry, 'CREATE');
    }
    if (existing.connectorId !== entry.connectorId || existing.connectorVersion !== entry.version) throw new DomainError('CONFLICT', 'Tool configuration identity collision: ' + rowId);
    if (existing.digest !== digest) throw new DomainError('CONFLICT', 'Tool configuration version content is immutable: ' + entry.connectorId + '@' + entry.version);
    if (existing.status === entry.status) return this.change(entry, 'UNCHANGED');
    if (dryRun) return this.change(entry, entry.status === 'ACTIVE' ? 'ACTIVATE' : 'DEACTIVATE');
    if (entry.status === 'ACTIVE') await this.deactivateTools(tx, entry.connectorId);
    await tx.update(toolConfigurations).set({ status: entry.status, updatedAt: new Date() }).where(eq(toolConfigurations.id, rowId));
    return this.change(entry, entry.status === 'ACTIVE' ? 'ACTIVATE' : 'DEACTIVATE');
  }
  private async deactivateTools(tx: Transaction, connectorId: string): Promise<void> {
    await tx.update(toolConfigurations).set({ status: 'DISABLED', updatedAt: new Date() }).where(and(eq(toolConfigurations.connectorId, connectorId), eq(toolConfigurations.status, 'ACTIVE')));
  }

  private async applyVerificationPolicy(tx: Transaction, entry: ConfigurationEntry & { domain: 'VERIFICATION_POLICY' }, dryRun: boolean): Promise<ConfigurationChange> {
    const rowId = identityOf(entry).rowId;
    const humanReviewRequired = entry.humanReviewRequired ? 'true' : 'false';
    const digest = verificationDigest({ capabilityId: entry.capabilityId, version: entry.version, minimumSources: entry.minimumSources, maxAgeDays: entry.maxAgeDays, approvedProviders: entry.approvedProviders, humanReviewRequired, validFrom: entry.validFrom });
    const [existing] = await tx.select().from(verificationPolicies).where(eq(verificationPolicies.id, rowId)).limit(1);
    if (!existing) {
      if (dryRun) return this.change(entry, 'CREATE');
      if (entry.status === 'ACTIVE') await this.deactivateVerificationPolicies(tx, entry.capabilityId);
      await tx.insert(verificationPolicies).values({
        id: rowId, capabilityId: entry.capabilityId, version: entry.version, minimumSources: entry.minimumSources,
        maxAgeDays: entry.maxAgeDays, approvedProviders: [...entry.approvedProviders], humanReviewRequired, validFrom: entry.validFrom, status: entry.status,
      });
      return this.change(entry, 'CREATE');
    }
    const stored = verificationDigest({ capabilityId: existing.capabilityId, version: existing.version, minimumSources: existing.minimumSources, maxAgeDays: existing.maxAgeDays, approvedProviders: existing.approvedProviders, humanReviewRequired: existing.humanReviewRequired, validFrom: existing.validFrom });
    if (stored !== digest) throw new DomainError('CONFLICT', 'Verification policy version content is immutable: ' + entry.capabilityId + ' v' + entry.version);
    if (existing.status === entry.status) return this.change(entry, 'UNCHANGED');
    if (dryRun) return this.change(entry, entry.status === 'ACTIVE' ? 'ACTIVATE' : 'DEACTIVATE');
    if (entry.status === 'ACTIVE') await this.deactivateVerificationPolicies(tx, entry.capabilityId);
    await tx.update(verificationPolicies).set({ status: entry.status }).where(eq(verificationPolicies.id, rowId));
    return this.change(entry, entry.status === 'ACTIVE' ? 'ACTIVATE' : 'DEACTIVATE');
  }
  private async deactivateVerificationPolicies(tx: Transaction, capabilityId: string): Promise<void> {
    await tx.update(verificationPolicies).set({ status: 'DISABLED' })
      .where(and(eq(verificationPolicies.capabilityId, capabilityId), eq(verificationPolicies.status, 'ACTIVE')));
  }

  private async applyOffer(tx: Transaction, entry: ConfigurationEntry & { domain: 'RAAS_OFFER' }, dryRun: boolean): Promise<ConfigurationChange> {
    const configuration = {
      id: entry.offerId, version: entry.version, status: entry.status, label: entry.label, capabilityIds: entry.capabilityIds,
      deliverableSchemaVersion: entry.deliverableSchemaVersion, scope: entry.scope, exclusions: entry.exclusions,
      regions: entry.regions, locales: entry.locales, termsVersion: entry.termsVersion, currency: entry.currency,
      amountMinor: entry.amountMinor, taxPolicy: entry.taxPolicy, isExplicitlyFree: entry.isExplicitlyFree,
    };
    const digest = offerDigest({ currency: entry.currency, amountMinor: entry.amountMinor, configuration });
    const [existing] = await tx.select().from(offers).where(and(eq(offers.id, entry.offerId), eq(offers.version, entry.version))).limit(1);
    if (!existing) {
      if (dryRun) return this.change(entry, 'CREATE');
      if (entry.status === 'ACTIVE') await this.deactivateOffers(tx, entry.offerId);
      await tx.insert(offers).values({ id: entry.offerId, version: entry.version, status: entry.status, currency: entry.currency, amountMinor: entry.amountMinor, configuration });
      return this.change(entry, 'CREATE');
    }
    const stored = offerDigest({ currency: existing.currency, amountMinor: existing.amountMinor, configuration: existing.configuration });
    if (stored !== digest) throw new DomainError('CONFLICT', 'Offer version content is immutable: ' + entry.offerId + ' v' + entry.version);
    if (existing.status === entry.status) return this.change(entry, 'UNCHANGED');
    if (dryRun) return this.change(entry, entry.status === 'ACTIVE' ? 'ACTIVATE' : 'DEACTIVATE');
    if (entry.status === 'ACTIVE') await this.deactivateOffers(tx, entry.offerId);
    await tx.update(offers).set({ status: entry.status }).where(and(eq(offers.id, entry.offerId), eq(offers.version, entry.version)));
    return this.change(entry, entry.status === 'ACTIVE' ? 'ACTIVATE' : 'DEACTIVATE');
  }
  private async deactivateOffers(tx: Transaction, offerId: string): Promise<void> {
    await tx.update(offers).set({
      status: 'DISABLED',
      configuration: sql`${offers.configuration} || '{"status":"DISABLED"}'::jsonb`,
    }).where(and(eq(offers.id, offerId), eq(offers.status, 'ACTIVE')));
  }

  private async applyBudgetPolicy(tx: Transaction, actor: Principal, entry: ConfigurationEntry & { domain: 'BUDGET_POLICY' }, dryRun: boolean): Promise<ConfigurationChange> {
    const [workspace] = await tx.select({ id: identityWorkspaces.id }).from(identityWorkspaces).where(eq(identityWorkspaces.id, actor.workspaceId)).limit(1);
    if (!workspace) throw new DomainError('NOT_FOUND', 'Workspace does not exist');
    const rowId = 'budget-' + actor.workspaceId + '-' + entry.policyId + '-v' + entry.version;
    const payload = withoutStatus(entry);
    const digest = contentDigest(payload);
    const [existing] = await tx.select().from(budgetPolicies).where(eq(budgetPolicies.id, rowId)).limit(1);
    if (!existing) {
      if (dryRun) return this.change(entry, 'CREATE');
      if (entry.status === 'ACTIVE') await this.deactivateBudgetPolicies(tx, actor.workspaceId);
      await tx.insert(budgetPolicies).values({
        id: rowId, workspaceId: actor.workspaceId, version: entry.version, status: entry.status,
        payload, digest, configuredBy: actor.userId, updatedAt: new Date(),
      });
      return this.change(entry, 'CREATE');
    }
    if (existing.workspaceId !== actor.workspaceId || existing.digest !== digest) throw new DomainError('CONFLICT', 'Budget policy version content is immutable: ' + entry.policyId + ' v' + entry.version);
    if (existing.status === entry.status) return this.change(entry, 'UNCHANGED');
    if (dryRun) return this.change(entry, entry.status === 'ACTIVE' ? 'ACTIVATE' : 'DEACTIVATE');
    if (entry.status === 'ACTIVE') await this.deactivateBudgetPolicies(tx, actor.workspaceId);
    await tx.update(budgetPolicies).set({ status: entry.status, updatedAt: new Date() }).where(eq(budgetPolicies.id, rowId));
    return this.change(entry, entry.status === 'ACTIVE' ? 'ACTIVATE' : 'DEACTIVATE');
  }
  private async deactivateBudgetPolicies(tx: Transaction, workspaceId: string): Promise<void> {
    await tx.update(budgetPolicies).set({ status: 'DISABLED', updatedAt: new Date() })
      .where(and(eq(budgetPolicies.workspaceId, workspaceId), eq(budgetPolicies.status, 'ACTIVE')));
  }
}

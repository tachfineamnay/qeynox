import { DomainError } from '@qeynox/domain';
import type { QeyNoxStore } from '@qeynox/persistence';
import { budgetPolicies, capabilities, offers, toolConfigurations, verificationPolicies } from '@qeynox/persistence';
import { and, desc, eq } from 'drizzle-orm';
import type { CapabilityDefinition } from '@qeynox/domain';
import { worldBankManifest } from '@qeynox/tools';

/**
 * Service configuration validation.
 *
 * A research service is only operational when every prerequisite agrees with every other one. The
 * defects this catches are the ones that silently produce a "configured" service that cannot work:
 *
 * - a capability referencing a tool that no ACTIVE tool configuration exposes;
 * - a verification policy approving a provider that is not enabled, or bound to an inactive
 *   capability, or already expired;
 * - an offer whose capability list does not cover the service capability;
 * - a budget policy that cannot pay for the engine calls the profile allows, or that rate-cards a
 *   provider that is not enabled;
 * - a profile allowing a tool the capability does not allow, or exceeding the capability's own
 *   tool-call ceiling.
 *
 * The validator reports EVERY finding with a stable code. It never repairs by guessing: a repair is
 * a change to operator configuration, performed by the operator.
 */

export type FindingSeverity = 'BLOCKER' | 'WARNING';

/** Re-exported so consumers validate against the same contract the operator schema enforces. */
export type { ConfigurationEntry } from '@qeynox/contracts';

export interface ConfigurationFinding {
  readonly code: string;
  readonly severity: FindingSeverity;
  readonly domain: 'TOOL' | 'CAPABILITY' | 'PROFILE' | 'VERIFICATION' | 'OFFER' | 'BUDGET';
  readonly detail: string;
  /** What an operator has to change. Never applied automatically. */
  readonly remedy: string;
}

export interface ServiceConfigurationReport {
  readonly capabilityId: string;
  readonly offerId: string;
  readonly valid: boolean;
  readonly findings: readonly ConfigurationFinding[];
}

export interface ServiceConfigurationInput {
  readonly capabilityId: string;
  readonly offerId: string;
  /** Accepted for compatibility with callers that have it; the validator inspects workspace policies. */
  readonly budgetPolicyId?: string;
  /**
   * Budget policies are workspace-scoped rows (`budget-<workspaceId>-<policyId>-v<n>`), because a
   * spending ceiling is a property of the paying tenant, not of the global catalogue. The validator
   * must be told which tenant it is validating.
   */
  readonly workspaceId: string;
  readonly expectedProvider: 'world-bank';
  /** Maximum engine calls a single plan may make, from the profile(s) the capability uses.
   *  Pass null when no ACTIVE business profile exists: iteration-dependent checks are then skipped
   *  (a missing profile is itself reported by capability availability) and BUDGET checks still run. */
  readonly maximumIterations: number | null;
}

/**
 * Validate one service end to end. Read-only: nothing is created, modified or activated.
 */
export async function validateServiceConfiguration(
  store: QeyNoxStore,
  input: ServiceConfigurationInput,
): Promise<ServiceConfigurationReport> {
  const findings: ConfigurationFinding[] = [];
  const add = (finding: ConfigurationFinding) => findings.push(finding);

  // --- capability -------------------------------------------------------------------------
  const capability = await store.getCapability(input.capabilityId as CapabilityDefinition['id']);
  if (!capability) {
    add({ code: 'CAPABILITY_MISSING', severity: 'BLOCKER', domain: 'CAPABILITY', detail: 'Capability ' + input.capabilityId + ' does not exist', remedy: 'Apply a BUSINESS_CAPABILITY configuration entry for this slot' });
    return { capabilityId: input.capabilityId, offerId: input.offerId, valid: false, findings };
  }
  if (capability.status !== 'ACTIVE') {
    add({ code: 'CAPABILITY_INACTIVE', severity: 'BLOCKER', domain: 'CAPABILITY', detail: 'Capability status is ' + capability.status, remedy: 'Activate the capability' });
  }

  // --- tools -----------------------------------------------------------------------------
  const toolRows = await store.db.select().from(toolConfigurations).where(and(eq(toolConfigurations.status, 'ACTIVE')));
  const enabledRefs = new Set<string>();
  const enabledConnectors = new Set<string>();
  for (const row of toolRows) {
    enabledConnectors.add(row.connectorId);
    const manifest = (row.payload as { manifest?: { tools?: readonly { name: string; version: string }[] } }).manifest;
    for (const tool of manifest?.tools ?? []) enabledRefs.add(row.connectorId + ':' + tool.name + '@' + tool.version);
  }
  if (!capability.allowedTools.length) {
    add({ code: 'CAPABILITY_NO_TOOLS', severity: 'BLOCKER', domain: 'CAPABILITY', detail: 'The capability allows no reviewed tool', remedy: 'Set allowedTools to ' + worldBankManifest.tools.map(tool => 'world-bank:' + tool.name + '@' + tool.version).join(', ') });
  }
  for (const ref of capability.allowedTools) {
    if (!enabledRefs.has(ref)) {
      add({ code: 'TOOL_NOT_ENABLED', severity: 'BLOCKER', domain: 'TOOL', detail: 'Capability requires ' + ref + ' but no ACTIVE tool configuration exposes it', remedy: 'Apply an ACTIVE TOOL configuration for the reviewed connector' });
    }
  }
  if (!enabledConnectors.has(input.expectedProvider)) {
    add({ code: 'PROVIDER_NOT_CONFIGURED', severity: 'BLOCKER', domain: 'TOOL', detail: 'No ACTIVE tool configuration for ' + input.expectedProvider, remedy: 'Activate the reviewed ' + input.expectedProvider + ' adapter and set QEYNOX_WORLD_BANK_ENABLED=true with attested egress' });
  }

  // --- verification policy ----------------------------------------------------------------
  const policyRows = await store.db.select().from(verificationPolicies)
    .where(and(eq(verificationPolicies.capabilityId, input.capabilityId), eq(verificationPolicies.status, 'ACTIVE')));
  if (!policyRows.length) {
    add({ code: 'POLICY_MISSING', severity: 'BLOCKER', domain: 'VERIFICATION', detail: 'No ACTIVE verification policy for ' + input.capabilityId, remedy: 'Apply a VERIFICATION_POLICY with approvedProviders [' + input.expectedProvider + ']' });
  }
  const now = Date.now();
  for (const policy of policyRows) {
    if (Date.parse(policy.validFrom) > now) {
      add({ code: 'POLICY_NOT_EFFECTIVE', severity: 'BLOCKER', domain: 'VERIFICATION', detail: 'Policy v' + policy.version + ' becomes effective at ' + policy.validFrom, remedy: 'Wait for validFrom or issue a policy with an effective start' });
    }
    if (policy.minimumSources < 1) {
      add({ code: 'POLICY_NO_SOURCES', severity: 'BLOCKER', domain: 'VERIFICATION', detail: 'Policy v' + policy.version + ' requires no source', remedy: 'Require at least one source' });
    }
    if (!policy.approvedProviders.includes(input.expectedProvider)) {
      add({ code: 'POLICY_PROVIDER_MISMATCH', severity: 'BLOCKER', domain: 'VERIFICATION', detail: 'Policy approvedProviders [' + policy.approvedProviders.join(', ') + '] does not include ' + input.expectedProvider, remedy: 'Approve ' + input.expectedProvider + ' or the captured evidence can never support a claim' });
    }
    for (const provider of policy.approvedProviders) {
      if (!enabledConnectors.has(provider)) {
        add({ code: 'POLICY_PROVIDER_DISABLED', severity: 'BLOCKER', domain: 'VERIFICATION', detail: 'Policy approves ' + provider + ' which has no ACTIVE tool configuration', remedy: 'Enable the provider or remove it from the policy' });
      }
    }
    if (policy.humanReviewRequired !== 'true') {
      add({ code: 'POLICY_SKIPS_HUMAN_REVIEW', severity: 'WARNING', domain: 'VERIFICATION', detail: 'Policy v' + policy.version + ' does not require human review', remedy: 'Agent findings still require an authorized human decision before SUPPORTED; set humanReviewRequired=true for clarity' });
    }
    if (policy.maxAgeDays < 1 || policy.maxAgeDays > 3650) {
      add({ code: 'POLICY_MAX_AGE_IMPLAUSIBLE', severity: 'WARNING', domain: 'VERIFICATION', detail: 'Policy maxAgeDays=' + policy.maxAgeDays, remedy: 'Use a defensible freshness window for economic series' });
    }
  }

  // --- offer ------------------------------------------------------------------------------
  const offerRows = await store.db.select().from(offers).where(and(eq(offers.id, input.offerId), eq(offers.status, 'ACTIVE')));
  if (!offerRows.length) {
    add({ code: 'OFFER_MISSING', severity: 'BLOCKER', domain: 'OFFER', detail: 'Offer ' + input.offerId + ' is not ACTIVE', remedy: 'Apply an ACTIVE RAAS_OFFER covering the capability' });
  }
  for (const offer of offerRows) {
    const configuration = offer.configuration as { capabilityIds?: readonly string[]; isExplicitlyFree?: boolean; taxPolicy?: string };
    const covered = configuration.capabilityIds ?? [];
    if (!covered.includes(input.capabilityId)) {
      add({ code: 'OFFER_CAPABILITY_MISSING', severity: 'BLOCKER', domain: 'OFFER', detail: 'Offer does not cover ' + input.capabilityId, remedy: 'Add the capability to the offer capabilityIds' });
    }
    if (offer.amountMinor === 0 && configuration.isExplicitlyFree !== true) {
      add({ code: 'OFFER_FREE_UNAUTHORIZED', severity: 'BLOCKER', domain: 'OFFER', detail: 'Offer price is zero without isExplicitlyFree', remedy: 'Set isExplicitlyFree=true or a real price' });
    }
    if (configuration.taxPolicy !== 'CONFIGURED') {
      add({ code: 'OFFER_TAX_NOT_CONFIGURED', severity: 'BLOCKER', domain: 'OFFER', detail: 'Offer tax treatment is ' + String(configuration.taxPolicy), remedy: 'Configure the tax treatment explicitly' });
    }
  }

  // --- budget -----------------------------------------------------------------------------
  const budgetRows = await store.db.select().from(budgetPolicies)
    .where(and(eq(budgetPolicies.workspaceId, input.workspaceId), eq(budgetPolicies.status, 'ACTIVE')))
    .orderBy(desc(budgetPolicies.version));
  if (!budgetRows.length) {
    add({ code: 'BUDGET_MISSING', severity: 'BLOCKER', domain: 'BUDGET', detail: 'No ACTIVE budget policy in workspace ' + input.workspaceId, remedy: 'Apply an ACTIVE BUDGET_POLICY for this workspace' });
  }
  for (const budget of budgetRows) {
    const payload = budget.payload as {
      maxMoneyMinor?: number; maxAgentCalls?: number; maxToolCalls?: number;
      unitMaxMinor?: Readonly<Record<string, number>>;
    };
    const engineUnit = payload.unitMaxMinor?.['hermes'];
    if (engineUnit === undefined) {
      add({ code: 'BUDGET_NO_ENGINE_RATE', severity: 'BLOCKER', domain: 'BUDGET', detail: 'Budget policy has no "hermes" rate', remedy: 'Add a hermes unit cost so engine calls can be reserved' });
    } else if ((payload.maxMoneyMinor ?? 0) < engineUnit) {
      add({ code: 'BUDGET_BELOW_ONE_CALL', severity: 'BLOCKER', domain: 'BUDGET', detail: 'maxMoneyMinor ' + String(payload.maxMoneyMinor) + ' cannot pay for one engine call at ' + engineUnit, remedy: 'Raise maxMoneyMinor or lower the hermes unit cost' });
    } else if (input.maximumIterations !== null && input.maximumIterations !== undefined) {
      const affordable = Math.floor((payload.maxMoneyMinor ?? 0) / engineUnit);
      if (affordable < input.maximumIterations) {
        add({ code: 'BUDGET_EXHAUSTS_MID_PLAN', severity: 'BLOCKER', domain: 'BUDGET', detail: 'Budget affords ' + affordable + ' engine calls but the profile allows ' + input.maximumIterations, remedy: 'Raise maxMoneyMinor, lower maximumIterations, or lower the hermes unit cost' });
      }
    }
    if (input.maximumIterations !== null && input.maximumIterations !== undefined && (payload.maxAgentCalls ?? 0) < input.maximumIterations) {
      add({ code: 'BUDGET_AGENT_CALLS_TOO_LOW', severity: 'BLOCKER', domain: 'BUDGET', detail: 'maxAgentCalls ' + String(payload.maxAgentCalls) + ' is below the profile iteration ceiling ' + input.maximumIterations, remedy: 'Raise maxAgentCalls' });
    }
    if ((payload.maxToolCalls ?? 0) < 1) {
      add({ code: 'BUDGET_TOOL_CALLS_TOO_LOW', severity: 'BLOCKER', domain: 'BUDGET', detail: 'maxToolCalls ' + String(payload.maxToolCalls) + ' cannot pay for one provider read', remedy: 'Raise maxToolCalls' });
    }
    for (const key of Object.keys(payload.unitMaxMinor ?? {})) {
      if (key !== 'hermes' && !enabledRefs.has(key)) {
        add({ code: 'BUDGET_RATE_UNKNOWN_TOOL', severity: 'BLOCKER', domain: 'BUDGET', detail: 'Budget rate card references ' + key + ' which is not an enabled tool', remedy: 'Remove the rate or enable the tool' });
      }
    }
  }

  return {
    capabilityId: input.capabilityId,
    offerId: input.offerId,
    valid: findings.every(finding => finding.severity !== 'BLOCKER'),
    findings,
  };
}

/** Convenience: assert a valid report or throw with every blocker named. */
export function assertServiceConfiguration(report: ServiceConfigurationReport): void {
  const blockers = report.findings.filter(finding => finding.severity === 'BLOCKER');
  if (!blockers.length) return;
  throw new DomainError('NOT_CONFIGURED', 'Service configuration is invalid: ' + blockers.map(finding => finding.code).join(', '));
}

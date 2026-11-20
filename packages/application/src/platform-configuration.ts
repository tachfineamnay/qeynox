import { DomainError, type ID, type PlatformPrincipal } from '@qeynox/domain';
import type { PlatformConfigurationApplyInput } from '@qeynox/contracts';
import { QeyNoxStore, WorkspaceStore } from '@qeynox/persistence';
import { and, eq } from 'drizzle-orm';
import { agentProfiles } from '@qeynox/persistence';
import { ConfigurationService, type ConfigurationApplyResult, type ConfigurationState } from './configuration';
import { validateServiceConfiguration, type ServiceConfigurationReport } from './service-configuration';
import { PlatformAdminService, type PlatformPermissionContext } from './platform-admin';

/**
 * Platform-side view of the operator configuration engine for the Control console.
 *
 * Authorization is deliberately two-layered and both layers must pass:
 *
 * 1. Platform layer — reads require CONSULTATION (PLATFORM_ADMIN, AUDITOR); previews and
 *    applications require ADMINISTRATION (PLATFORM_ADMIN only). SUPPORT and OPERATIONS hold no
 *    configuration permission. A permission failure throws before any engine work and is audited
 *    by PlatformAdminService.
 * 2. Operator layer — the ConfigurationService engine still enforces QEYNOX_OPERATOR_USER_IDS
 *    (failing closed with NOT_CONFIGURED when unset), allowlist membership of the acting identity
 *    and an ACTIVE OWNER/ADMIN/OPERATOR membership in the target workspace. A platform session
 *    never becomes a workspace session: no workspace token is minted, an in-memory Principal is
 *    synthesized from the platform actor and its *real* membership role in the target workspace.
 *
 * Every call takes an explicit workspaceId. Every success and every denial is written to the
 * append-only platform audit trail; preview/apply audit rows are committed inside the same
 * transaction as the configuration mutation, so an applied configuration can never exist without
 * its audit record.
 */
export class PlatformConfigurationService {
  private readonly configuration: ConfigurationService;

  constructor(
    private readonly store: QeyNoxStore,
    private readonly platform: PlatformAdminService,
    private readonly workspaces: WorkspaceStore,
  ) {
    this.configuration = new ConfigurationService(store);
  }

  /**
   * Read-only configuration state (capability slots, profiles, tools, policies, offers incl. tax,
   * budgets). Authorized by platform CONSULTATION plus an existing workspace row; deliberately
   * outside the operator allowlist gate so the console can report a not-yet-configured deployment.
   * No customer data and no credentials are exposed — desired-state configuration only.
   */
  async state(principal: PlatformPrincipal, workspaceId: string): Promise<ConfigurationState> {
    await this.platform.requirePermission(principal, 'CONSULTATION', {
      action: 'READ_PLATFORM_CONFIGURATION',
      targetType: 'PLATFORM_CONFIGURATION',
      targetId: workspaceId,
    });
    await this.assertWorkspace(principal, workspaceId, 'READ_PLATFORM_CONFIGURATION', null);
    const roles = await this.operatorRolesFor(principal.userId, workspaceId);
    try {
      const state = await this.configuration.state({ userId: principal.userId, workspaceId: workspaceId as ID, roles }, { bypassOperatorGate: true });
      await this.platform.recordAudit({
        actor: principal, targetType: 'PLATFORM_CONFIGURATION', targetId: workspaceId,
        action: 'READ_PLATFORM_CONFIGURATION', permission: 'CONSULTATION', outcome: 'SUCCESS',
        detail: { workspaceId },
      });
      return state;
    } catch (error: unknown) {
      await this.denied(principal, 'READ_PLATFORM_CONFIGURATION', workspaceId, error, { workspaceId });
      throw error;
    }
  }

  /** Dry-run application: identical validation and outcome computation, persists nothing except the audit row. */
  preview(principal: PlatformPrincipal, input: PlatformConfigurationApplyInput): Promise<ConfigurationApplyResult> {
    return this.run(principal, input, true);
  }

  /** Real application, idempotency-key guarded and committed together with its audit row. */
  apply(principal: PlatformPrincipal, input: PlatformConfigurationApplyInput): Promise<ConfigurationApplyResult> {
    return this.run(principal, input, false);
  }

  /**
   * Read-only validation of one service definition against the live configuration. Authorization is
   * the same two-layer shape as state(): platform CONSULTATION plus an existing workspace. Nothing is
   * created, modified or activated; the report names every BLOCKER and its remedy. The iteration
   * basis is the ACTIVE business profile for the capability's slot — reported, never assumed.
   */
  async validateService(principal: PlatformPrincipal, input: { readonly workspaceId: string; readonly capabilityId: string; readonly offerId: string; readonly expectedProvider: 'world-bank' }): Promise<ServiceConfigurationReport & { readonly maximumIterations: number | null }> {
    const action = 'READ_PLATFORM_SERVICE_VALIDATION';
    await this.platform.requirePermission(principal, 'CONSULTATION', {
      action,
      targetType: 'PLATFORM_CONFIGURATION',
      targetId: input.workspaceId,
    });
    await this.assertWorkspace(principal, input.workspaceId, action, null);
    try {
      const capability = await this.store.getCapability(input.capabilityId as ID);
      let maximumIterations: number | null = null;
      if (capability) {
        const [profile] = await this.store.db.select().from(agentProfiles)
          .where(and(eq(agentProfiles.roleKey, 'business:' + capability.slot), eq(agentProfiles.active, true))).limit(1);
        const fromProfile = (profile?.payload as { maxIterations?: unknown } | undefined)?.maxIterations;
        maximumIterations = typeof fromProfile === 'number' && Number.isInteger(fromProfile) && fromProfile > 0 ? fromProfile : null;
      }
      const report = await validateServiceConfiguration(this.store, {
        capabilityId: input.capabilityId,
        offerId: input.offerId,
        workspaceId: input.workspaceId,
        expectedProvider: input.expectedProvider,
        maximumIterations,
      });
      await this.platform.recordAudit({
        actor: principal, targetType: 'PLATFORM_CONFIGURATION', targetId: input.workspaceId,
        action, permission: 'CONSULTATION', outcome: 'SUCCESS',
        detail: { workspaceId: input.workspaceId, capabilityId: input.capabilityId, offerId: input.offerId, valid: report.valid, blockers: report.findings.filter(finding => finding.severity === 'BLOCKER').map(finding => finding.code) },
      });
      return { ...report, maximumIterations };
    } catch (error: unknown) {
      await this.denied(principal, action, input.workspaceId, error, { workspaceId: input.workspaceId, capabilityId: input.capabilityId, offerId: input.offerId });
      throw error;
    }
  }

  /** Controller hook re-exported so route validation stays audited with the same rules. */
  recordInputRejection(principal: PlatformPrincipal | undefined, context: PlatformPermissionContext): Promise<void> {
    return this.platform.recordInputRejection(principal, context);
  }

  private async run(principal: PlatformPrincipal, input: PlatformConfigurationApplyInput, dryRun: boolean): Promise<ConfigurationApplyResult> {
    const action = dryRun ? 'PREVIEW_PLATFORM_CONFIGURATION' : 'APPLY_PLATFORM_CONFIGURATION';
    await this.platform.requirePermission(principal, 'ADMINISTRATION', {
      action,
      targetType: 'PLATFORM_CONFIGURATION',
      targetId: input.workspaceId,
    });
    await this.assertWorkspace(principal, input.workspaceId, action, input.reason);
    const roles = await this.operatorRolesFor(principal.userId, input.workspaceId);
    try {
      return await this.configuration.apply(
        { userId: principal.userId, workspaceId: input.workspaceId as ID, roles },
        { idempotencyKey: input.idempotencyKey, entries: input.entries, dryRun },
        {
          audit: result => this.platform.buildAuditRecord({
            actor: principal, targetType: 'PLATFORM_CONFIGURATION', targetId: input.workspaceId,
            action, permission: 'ADMINISTRATION', outcome: 'SUCCESS', reason: input.reason,
            detail: {
              justification: input.reason,
              workspaceId: input.workspaceId,
              dryRun,
              idempotencyKey: result.idempotencyKey,
              digest: result.digest,
              alreadyApplied: result.alreadyApplied,
              changes: result.changes.map(change => ({
                domain: change.domain, key: change.key, version: change.version, outcome: change.outcome,
              })),
            },
          }),
        },
      );
    } catch (error: unknown) {
      await this.denied(principal, action, input.workspaceId, error, {
        workspaceId: input.workspaceId, justification: input.reason, dryRun,
      });
      throw error;
    }
  }

  private async assertWorkspace(principal: PlatformPrincipal, workspaceId: string, action: string, reason: string | null): Promise<void> {
    const workspace = await this.workspaces.findWorkspace(workspaceId);
    if (!workspace) {
      await this.platform.recordAudit({
        actor: principal, targetType: 'PLATFORM_CONFIGURATION', targetId: workspaceId,
        action, permission: action.startsWith('READ_') ? 'CONSULTATION' : 'ADMINISTRATION',
        outcome: 'DENIED', reason: 'WORKSPACE_NOT_FOUND',
        detail: { workspaceId, ...(reason ? { justification: reason } : {}) },
      });
      throw new DomainError('NOT_FOUND', 'Workspace does not exist');
    }
  }

  private async operatorRolesFor(userId: ID, workspaceId: string): Promise<readonly string[]> {
    const membership = await this.workspaces.findActiveMembership(userId, workspaceId);
    return membership ? [membership.role] : [];
  }

  private async denied(
    principal: PlatformPrincipal,
    action: string,
    workspaceId: string,
    error: unknown,
    detail: Record<string, unknown>,
  ): Promise<void> {
    const code = error instanceof DomainError ? error.code : 'ERROR';
    try {
      await this.platform.recordAudit({
        actor: principal, targetType: 'PLATFORM_CONFIGURATION', targetId: workspaceId,
        action, permission: action.startsWith('READ_') ? 'CONSULTATION' : 'ADMINISTRATION',
        outcome: code === 'ERROR' ? 'ERROR' : 'DENIED', reason: code, detail,
      });
    } catch {
      // Best effort: the error itself is authoritative, an audit outage must not mask it.
    }
  }
}

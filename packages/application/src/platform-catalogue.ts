import type { PlatformPrincipal } from '@qeynox/domain';
import type { QeyNoxStore } from '@qeynox/persistence';
import { CapabilityCatalogueService, type CapabilityCatalogueView } from './capability-catalogue';
import type { PlatformAdminService } from './platform-admin';
import type { RuntimeReadiness, RuntimeReadinessSource } from './runtime-readiness';

export interface OperatorConfigurationFacts {
  readonly allowlistConfigured: boolean;
  readonly configurationEndpoint: string;
  /** Audited platform route that reaches the same engine under platform authorization. */
  readonly platformConfigurationEndpoint: string;
}

export interface PlatformCatalogueView extends CapabilityCatalogueView {
  /** Execution runtime prerequisites of the deployment, reported from its own environment. */
  readonly runtime: RuntimeReadiness;
  /** Workspace-scoped operator configuration is never implied by a platform session. */
  readonly operator: {
    readonly scope: 'WORKSPACE';
    readonly configurationEndpoint: string;
    readonly platformConfigurationEndpoint: string;
    readonly allowlistConfigured: boolean;
  };
}

/**
 * Read-only platform view of the eight business capability slots and the deployment prerequisites.
 *
 * It requires the existing CONSULTATION permission (PLATFORM_ADMIN, AUDITOR). It performs no
 * configuration change itself. Configuration changes remain workspace-scoped operator actions:
 * either through the workspace operator path, or through the audited platform route
 * /v1/platform/configuration/* — which requires the ADMINISTRATION permission for previews and
 * applications (CONSULTATION for reads), an explicit workspaceId, a mandatory written justification,
 * and which still passes the operator engine's own gates (QEYNOX_OPERATOR_USER_IDS and an ACTIVE
 * OWNER/ADMIN/OPERATOR membership in the target workspace). A platform session never becomes a
 * workspace session; the platform route synthesizes an in-memory Principal with the actor's real
 * membership role and never mints a workspace token.
 */
export class PlatformCatalogueService {
  private readonly catalogue: CapabilityCatalogueService;
  constructor(
    store: QeyNoxStore,
    private readonly platform: PlatformAdminService,
    private readonly runtime: RuntimeReadinessSource,
    private readonly operator: OperatorConfigurationFacts,
  ) {
    this.catalogue = new CapabilityCatalogueService(store, runtime);
  }

  async read(principal: PlatformPrincipal): Promise<PlatformCatalogueView> {
    await this.platform.requirePermission(principal, 'CONSULTATION', {
      action: 'READ_PLATFORM_CATALOGUE',
      targetType: 'PLATFORM_CATALOGUE',
    });
    const snapshot = await this.catalogue.snapshot();
    return {
      ...snapshot,
      runtime: this.runtime(),
      operator: {
        scope: 'WORKSPACE',
        configurationEndpoint: this.operator.configurationEndpoint,
        platformConfigurationEndpoint: this.operator.platformConfigurationEndpoint,
        allowlistConfigured: this.operator.allowlistConfigured,
      },
    };
  }
}

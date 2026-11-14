import type { PlatformPrincipal } from '@qeynox/domain';
import type { QeyNoxStore } from '@qeynox/persistence';
import { CapabilityCatalogueService, type CapabilityCatalogueView } from './capability-catalogue';
import type { PlatformAdminService } from './platform-admin';
import type { RuntimeReadiness, RuntimeReadinessSource } from './runtime-readiness';

export interface OperatorConfigurationFacts {
  readonly allowlistConfigured: boolean;
  readonly configurationEndpoint: string;
}

export interface PlatformCatalogueView extends CapabilityCatalogueView {
  /** Execution runtime prerequisites of the deployment, reported from its own environment. */
  readonly runtime: RuntimeReadiness;
  /** Workspace-scoped operator configuration is never implied by a platform session. */
  readonly operator: {
    readonly scope: 'WORKSPACE';
    readonly configurationEndpoint: string;
    readonly allowlistConfigured: boolean;
  };
}

/**
 * Read-only platform view of the eight business capability slots and the deployment prerequisites.
 *
 * It requires the existing CONSULTATION permission (PLATFORM_ADMIN, AUDITOR). It performs no
 * configuration change: capability, profile, tool and budget configuration remain on the
 * workspace operator path, which a platform session never receives.
 */
export class PlatformCatalogueService {
  private readonly catalogue: CapabilityCatalogueService;
  constructor(
    store: QeyNoxStore,
    private readonly platform: PlatformAdminService,
    private readonly runtime: RuntimeReadinessSource,
    private readonly operator: OperatorConfigurationFacts,
  ) {
    this.catalogue = new CapabilityCatalogueService(store);
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
        allowlistConfigured: this.operator.allowlistConfigured,
      },
    };
  }
}

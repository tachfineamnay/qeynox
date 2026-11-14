import { DomainError, type PlatformPrincipal } from '@qeynox/domain';
import type {
  PlatformAnomalyFacts, PlatformHealthFacts, PlatformOperationDetailExtra, PlatformOperationListRow,
  PlatformOperationRuntime, PlatformOperationSummary, PlatformOperationsCounts, PlatformRecoveryIncidentRow,
} from '@qeynox/persistence';
import { PlatformAdminService } from './platform-admin';

export interface PlatformOperationsRepository {
  listOperations(input: { readonly status?: string | undefined; readonly limit: number }): Promise<{ readonly items: readonly PlatformOperationListRow[]; readonly total: number }>;
  counts(): Promise<PlatformOperationsCounts>;
  getOperationDetail(operationId: string): Promise<PlatformOperationDetailExtra | undefined>;
  listIncidents(limit: number): Promise<readonly PlatformRecoveryIncidentRow[]>;
  healthFacts(): Promise<PlatformHealthFacts>;
  anomalyFacts(since: Date): Promise<PlatformAnomalyFacts>;
}
export interface PlatformOperationRuntimeReader {
  readOperationSummary(operationId: string): Promise<PlatformOperationSummary | undefined>;
  readOperationRuntime(operationId: string): Promise<PlatformOperationRuntime | undefined>;
}
export interface DeploymentInfoView {
  readonly version: { readonly value: string | null; readonly source: string };
  readonly commit: { readonly value: string | null; readonly source: string };
  readonly deployedAt: { readonly value: string | null; readonly source: string };
  readonly nodeVersion: string;
  readonly uptimeSeconds: number;
}
export interface DeploymentInfoPort { info(): DeploymentInfoView }
export interface ResourceInventoryCapability {
  readonly provider: 'COOLIFY';
  readonly status: 'CONFIGURED' | 'NOT_CONFIGURED' | 'UNAVAILABLE';
  readonly reason: string | null;
  readonly readOnly: true;
}
export interface ResourceInventoryItem {
  readonly id: string; readonly type: 'SERVER' | 'APPLICATION' | 'SERVICE';
  readonly name: string; readonly status: string; readonly fqdn: string | null;
}
export interface ResourceInventoryPort {
  list(): Promise<{ readonly capability: ResourceInventoryCapability; readonly resources: readonly ResourceInventoryItem[] }>;
}
export interface PlatformOperationListView {
  readonly items: readonly PlatformOperationListRow[];
  readonly counts: PlatformOperationsCounts;
  readonly total: number;
}
export interface PlatformOperationDetailView {
  readonly summary: PlatformOperationSummary;
  readonly runtime: PlatformOperationRuntime;
  readonly events: PlatformOperationDetailExtra['events'];
  readonly incidents: readonly PlatformRecoveryIncidentRow[];
}

const operationsRead = { targetType: 'PLATFORM_OPERATIONS' } as const;

/**
 * Read-only operations desk service. It never mutates, retries, cancels or redeploys: every method
 * requires the existing OPERATIONS permission and only reads QeyNox read models plus the optional
 * read-only resource inventory. Missing data is reported as UNAVAILABLE, never fabricated.
 */
export class PlatformOperationsService {
  constructor(
    private readonly store: PlatformOperationsRepository,
    private readonly runtime: PlatformOperationRuntimeReader,
    private readonly platform: PlatformAdminService,
    private readonly deployment: DeploymentInfoPort,
    private readonly inventory: ResourceInventoryPort,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async list(principal: PlatformPrincipal, input: { readonly status?: string | undefined; readonly limit?: number | undefined }): Promise<PlatformOperationListView> {
    await this.platform.requirePermission(principal, 'OPERATIONS', { ...operationsRead, action: 'LIST_PLATFORM_OPERATIONS' });
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
    const [page, counts] = await Promise.all([this.store.listOperations({ status: input.status, limit }), this.store.counts()]);
    return { items: page.items, counts, total: page.total };
  }

  async incidents(principal: PlatformPrincipal, limit: number): Promise<{ readonly items: readonly PlatformRecoveryIncidentRow[] }> {
    await this.platform.requirePermission(principal, 'OPERATIONS', { ...operationsRead, action: 'LIST_PLATFORM_INCIDENTS' });
    return { items: await this.store.listIncidents(Math.min(Math.max(limit, 1), 100)) };
  }

  async detail(principal: PlatformPrincipal, operationId: string): Promise<PlatformOperationDetailView> {
    await this.platform.requirePermission(principal, 'OPERATIONS', { ...operationsRead, action: 'READ_PLATFORM_OPERATION', targetType: 'OPERATION', targetId: operationId });
    const [summary, runtime, extra] = await Promise.all([
      this.runtime.readOperationSummary(operationId),
      this.runtime.readOperationRuntime(operationId),
      this.store.getOperationDetail(operationId),
    ]);
    if (!summary || !runtime || !extra) throw new DomainError('NOT_FOUND', 'Operation not found');
    return { summary, runtime, events: extra.events, incidents: extra.incidents };
  }

  async health(principal: PlatformPrincipal): Promise<{ readonly checkedAt: string; readonly checks: readonly { readonly name: string; readonly status: 'OK' | 'UNAVAILABLE'; readonly detail: string }[]; readonly deployment: DeploymentInfoView }> {
    await this.platform.requirePermission(principal, 'OPERATIONS', { ...operationsRead, action: 'READ_PLATFORM_HEALTH' });
    const deployment = this.deployment.info();
    const checks: { name: string; status: 'OK' | 'UNAVAILABLE'; detail: string }[] = [];
    try {
      const facts = await this.store.healthFacts();
      checks.push({ name: 'PostgreSQL', status: 'OK', detail: 'SELECT 1 responded in ' + facts.dbLatencyMs + ' ms' });
      checks.push({ name: 'schema_migrations', status: 'OK', detail: facts.migrations.count + ' applied' + (facts.migrations.latest ? ' · latest ' + facts.migrations.latest : '') });
      checks.push({ name: 'server_time', status: 'OK', detail: facts.serverTime });
    } catch {
      checks.push({ name: 'PostgreSQL', status: 'UNAVAILABLE', detail: 'database health read failed' });
    }
    checks.push({ name: 'QeyNox API', status: 'OK', detail: 'responding · uptime ' + deployment.uptimeSeconds + ' s' });
    return { checkedAt: this.now().toISOString(), checks, deployment };
  }

  async releases(principal: PlatformPrincipal): Promise<{ readonly version: DeploymentInfoView; readonly lastCheck: string | null; readonly migrations: PlatformHealthFacts['migrations'] | null; readonly anomalies: PlatformAnomalyFacts | null; readonly resources: ResourceInventoryCapability }> {
    await this.platform.requirePermission(principal, 'OPERATIONS', { ...operationsRead, action: 'READ_PLATFORM_RELEASES' });
    const version = this.deployment.info();
    const inventory = await this.inventory.list();
    let migrations: PlatformHealthFacts['migrations'] | null = null;
    let anomalies: PlatformAnomalyFacts | null = null;
    try { migrations = (await this.store.healthFacts()).migrations; } catch { migrations = null; }
    try { anomalies = await this.store.anomalyFacts(new Date(this.now().getTime() - 24 * 60 * 60 * 1000)); } catch { anomalies = null; }
    return { version, lastCheck: anomalies ? this.now().toISOString() : null, migrations, anomalies, resources: inventory.capability };
  }

  async resources(principal: PlatformPrincipal): Promise<{ readonly capability: ResourceInventoryCapability; readonly resources: readonly ResourceInventoryItem[] }> {
    await this.platform.requirePermission(principal, 'OPERATIONS', { ...operationsRead, action: 'READ_PLATFORM_RESOURCES' });
    return this.inventory.list();
  }
}

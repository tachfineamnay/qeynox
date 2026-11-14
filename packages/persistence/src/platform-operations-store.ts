import { desc, eq, gte, inArray, sql } from 'drizzle-orm';
import type { QeyNoxDatabase } from './database';
import { identityWorkspaces } from './identity-schema';
import { platformAdminAudit } from './platform-admin-schema';
import { recoveryActions, recoveryIncidents } from './recovery-schema';
import { operations } from './schema';
import { eventEnvelopes, operationViews } from './views-schema';

export interface PlatformOperationListRow {
  readonly operationId: string; readonly workspaceId: string; readonly workspaceName: string | null;
  readonly title: string; readonly status: string; readonly attention: string; readonly lastActivityAt: string;
  readonly stepCount: number; readonly completedSteps: number; readonly pendingApprovals: number; readonly resultCount: number;
}
export interface PlatformOperationsCounts {
  readonly statuses: readonly { readonly status: string; readonly count: number }[];
  readonly attentions: readonly { readonly attention: string; readonly count: number }[];
  readonly total: number;
}
export interface PlatformRecoveryActionRow {
  readonly id: string; readonly incidentId: string; readonly actorId: string;
  readonly action: string; readonly reason: string; readonly createdAt: string;
}
export interface PlatformRecoveryIncidentRow {
  readonly id: string; readonly workspaceId: string; readonly operationId: string;
  readonly category: string; readonly status: string; readonly reason: string;
  readonly createdAt: string; readonly updatedAt: string; readonly actions: readonly PlatformRecoveryActionRow[];
}
export interface PlatformOperationEventRow {
  readonly sequence: number; readonly kind: string; readonly occurredAt: string; readonly actorType: string;
  readonly revisionId: string | null; readonly attemptId: string | null; readonly data: Record<string, unknown>;
}
export interface PlatformOperationDetailExtra { readonly operationId: string; readonly events: readonly PlatformOperationEventRow[]; readonly incidents: readonly PlatformRecoveryIncidentRow[]; }
export interface PlatformHealthFacts {
  readonly dbLatencyMs: number;
  readonly migrations: { readonly count: number; readonly latest: string | null; readonly latestAppliedAt: string | null };
  readonly serverTime: string;
}
export interface PlatformAnomalyFacts {
  readonly since: string; readonly total: number;
  readonly byOutcome: readonly { readonly outcome: string; readonly count: number }[];
  readonly recent: readonly { readonly action: string; readonly outcome: string; readonly reason: string | null; readonly happenedAt: string }[];
}

function iso(value: string | Date): string { return typeof value === 'string' ? value : value.toISOString(); }

/** Read-only cross-workspace queries for the operations desk (no mutation, no monitoring engine). */
export class PlatformOperationsStore {
  constructor(private readonly db: QeyNoxDatabase) {}

  async listOperations(input: { readonly status?: string | undefined; readonly limit: number }): Promise<{ readonly items: readonly PlatformOperationListRow[]; readonly total: number }> {
    const where = input.status === undefined ? undefined : eq(operationViews.status, input.status);
    const rows = await this.db.select({
      operationId: operationViews.operationId, workspaceId: operationViews.workspaceId,
      workspaceName: identityWorkspaces.name, title: operationViews.title, status: operationViews.status,
      attention: operationViews.attention, lastActivityAt: operationViews.lastActivityAt,
      stepCount: operationViews.stepCount, completedSteps: operationViews.completedSteps,
      pendingApprovals: operationViews.pendingApprovals, resultCount: operationViews.resultCount,
    }).from(operationViews).leftJoin(identityWorkspaces, eq(identityWorkspaces.id, operationViews.workspaceId))
      .where(where).orderBy(desc(operationViews.lastActivityAt)).limit(input.limit);
    const [total] = await this.db.select({ value: sql<number>`count(*)::int` }).from(operationViews).where(where);
    return { items: rows, total: Number(total?.value ?? 0) };
  }

  async counts(): Promise<PlatformOperationsCounts> {
    const statuses = await this.db.select({ status: operationViews.status, count: sql<number>`count(*)::int` }).from(operationViews).groupBy(operationViews.status);
    const attentions = await this.db.select({ attention: operationViews.attention, count: sql<number>`count(*)::int` }).from(operationViews).groupBy(operationViews.attention);
    const total = statuses.reduce((sum, row) => sum + Number(row.count), 0);
    return {
      statuses: statuses.map(row => ({ status: row.status, count: Number(row.count) })).sort((a, b) => b.count - a.count),
      attentions: attentions.map(row => ({ attention: row.attention, count: Number(row.count) })).sort((a, b) => b.count - a.count),
      total,
    };
  }

  async getOperationDetail(operationId: string): Promise<PlatformOperationDetailExtra | undefined> {
    const [operation] = await this.db.select({ id: operations.id }).from(operations).where(eq(operations.id, operationId)).limit(1);
    if (!operation) return undefined;
    const [events, incidents] = await Promise.all([
      this.db.select().from(eventEnvelopes).where(eq(eventEnvelopes.operationId, operationId)).orderBy(eventEnvelopes.sequence).limit(200),
      this.db.select().from(recoveryIncidents).where(eq(recoveryIncidents.operationId, operationId)).orderBy(desc(recoveryIncidents.createdAt)),
    ]);
    return {
      operationId,
      events: events.map(row => ({
        sequence: row.sequence, kind: row.kind, occurredAt: row.occurredAt, actorType: row.actorType,
        revisionId: row.revisionId ?? null, attemptId: row.attemptId ?? null, data: row.data,
      })),
      incidents: await this.actionsForIncidents(incidents),
    };
  }

  async listIncidents(limit: number): Promise<readonly PlatformRecoveryIncidentRow[]> {
    const rows = await this.db.select().from(recoveryIncidents).orderBy(desc(recoveryIncidents.updatedAt)).limit(limit);
    return this.actionsForIncidents(rows);
  }

  private async actionsForIncidents(rows: readonly (typeof recoveryIncidents.$inferSelect)[]): Promise<readonly PlatformRecoveryIncidentRow[]> {
    if (rows.length === 0) return [];
    const actions = await this.db.select().from(recoveryActions).where(inArray(recoveryActions.incidentId, rows.map(row => row.id)));
    return rows.map(row => ({
      id: row.id, workspaceId: row.workspaceId, operationId: row.operationId, category: row.category,
      status: row.status, reason: row.reason, createdAt: row.createdAt, updatedAt: row.updatedAt,
      actions: actions.filter(action => action.incidentId === row.id).map(action => ({
        id: action.id, incidentId: action.incidentId, actorId: action.actorId,
        action: action.action, reason: action.reason, createdAt: action.createdAt,
      })),
    }));
  }

  async healthFacts(): Promise<PlatformHealthFacts> {
    const started = Date.now();
    await this.db.execute(sql`SELECT 1 AS ok`);
    const latency = Date.now() - started;
    const migrationRows = await this.db.execute(sql`SELECT name, applied_at FROM schema_migrations ORDER BY name DESC LIMIT 1`) as unknown as { rows: { name: string; applied_at: Date | string }[] };
    const countRows = await this.db.execute(sql`SELECT count(*)::int AS value FROM schema_migrations`) as unknown as { rows: { value: number }[] };
    const latest = migrationRows.rows[0];
    return {
      dbLatencyMs: latency,
      migrations: {
        count: Number(countRows.rows[0]?.value ?? 0),
        latest: latest?.name ?? null,
        latestAppliedAt: latest === undefined ? null : iso(latest.applied_at),
      },
      serverTime: new Date().toISOString(),
    };
  }

  async anomalyFacts(since: Date): Promise<PlatformAnomalyFacts> {
    const rows = await this.db.select({
      action: platformAdminAudit.action, outcome: platformAdminAudit.outcome,
      reason: platformAdminAudit.reason, happenedAt: platformAdminAudit.happenedAt,
    }).from(platformAdminAudit).where(gte(platformAdminAudit.happenedAt, since)).orderBy(desc(platformAdminAudit.happenedAt)).limit(500);
    const grouped = new Map<string, number>();
    for (const row of rows) grouped.set(row.outcome, (grouped.get(row.outcome) ?? 0) + 1);
    const failures = rows.filter(row => row.outcome !== 'SUCCESS').slice(0, 20);
    return {
      since: since.toISOString(),
      total: rows.length,
      byOutcome: Array.from(grouped.entries()).map(([outcome, count]) => ({ outcome, count })),
      recent: failures.map(row => ({ action: row.action, outcome: row.outcome, reason: row.reason, happenedAt: iso(row.happenedAt) })),
    };
  }
}

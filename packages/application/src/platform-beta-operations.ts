import { and, eq, gt, sql } from 'drizzle-orm';
import { DomainError, operationalErrorCode, type PlatformPrincipal } from '@qeynox/domain';
import { operationsQueueQuerySchema, operationsRecoverySchema, queuePageSchema, spendingQuerySchema, providerSpendingSchema } from '@qeynox/contracts';
import { outbox, operations, attempts, platformAdminAudit, loadMigrations, compareMigrationHistory, type QeyNoxStore } from '@qeynox/persistence';
import type { PlatformAdminService } from './platform-admin';
import { summarizeRuntimeComponent, type RuntimeReadiness } from './runtime-readiness';
import { classifyRecoveryIncident } from './recovery';

/** Existing Control operations desk extension. Metadata only; no queue payload or external command. */
export class PlatformBetaOperationsService {
  constructor(private readonly store: QeyNoxStore, private readonly platform: PlatformAdminService) {}

  async queues(actor: PlatformPrincipal, query: unknown) {
    await this.platform.requirePermission(actor, 'OPERATIONS', { action: 'READ_BETA_QUEUES', targetType: 'OPERATIONS_QUEUE' });
    const input = operationsQueueQuerySchema.parse(query);
    return this.store.db.transaction(async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      await tx.execute(sql`SET LOCAL statement_timeout = '5000ms'`);
      // Reviewed projections only: no payload, storage key, lease token, email address/subject/template.
      const views = {
        OUTBOX: sql`SELECT id, workspace_id, operation_id, NULL::text AS document_id, state, attempts,
          last_error AS error_code,
          created_at::text, next_attempt_at::text, CASE WHEN state='DISPATCHING' THEN next_attempt_at::text END AS lease_expires_at,
          state IN ('UNKNOWN','DISPATCHING') AS uncertain,
          (state='PENDING' AND attempts=0 AND topic='EXECUTE_STEP' AND next_attempt_at > to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) AS can_expedite FROM outbox`,
        INGESTION: sql`SELECT id, workspace_id, NULL::text AS operation_id, document_id, state, attempts,
          last_error_code AS error_code,
          created_at::text, NULL::text AS next_attempt_at, lease_expires_at::text, false AS uncertain, false AS can_expedite FROM document_ingest_jobs`,
        DELETION: sql`SELECT id, workspace_id, NULL::text AS operation_id, document_id, state, attempts,
          last_error_code AS error_code,
          created_at::text, not_before::text AS next_attempt_at, lease_expires_at::text, false AS uncertain, false AS can_expedite FROM document_storage_deletions`,
        EMAIL: sql`SELECT id, workspace_id, NULL::text AS operation_id, NULL::text AS document_id, status AS state, attempt_count AS attempts,
          last_error_code AS error_code,
          created_at::text, next_retry_at::text AS next_attempt_at, lease_expires_at::text, outcome_uncertain AS uncertain, false AS can_expedite FROM email_deliveries`,
      };
      const result = await tx.execute(sql`SELECT id, workspace_id AS "workspaceId", operation_id AS "operationId", document_id AS "documentId",
        state, attempts, error_code AS "errorCode", created_at AS "createdAt", next_attempt_at AS "nextAttemptAt", lease_expires_at AS "leaseExpiresAt", uncertain, can_expedite AS "canExpedite"
        FROM (${views[input.kind]}) q
        WHERE (${input.workspaceId ?? null}::text IS NULL OR workspace_id=${input.workspaceId ?? null})
          AND (${input.operationId ?? null}::text IS NULL OR operation_id=${input.operationId ?? null})
          AND (${input.state ?? null}::text IS NULL OR state=${input.state ?? null})
        ORDER BY created_at DESC, id DESC LIMIT ${input.limit + 1} OFFSET ${input.offset}`);
      return queuePageSchema.parse({ kind: input.kind, items: result.rows.slice(0, input.limit).map(row => ({ ...row, errorCode: operationalErrorCode(row.errorCode) })), hasMore: result.rows.length > input.limit, limit: input.limit, offset: input.offset });
    });
  }

  async spending(actor: PlatformPrincipal, query: unknown) {
    await this.platform.requirePermission(actor, 'OPERATIONS', { action: 'READ_PROVIDER_SPENDING', targetType: 'WORKSPACE_SPENDING' });
    const input = spendingQuerySchema.parse(query);
    return this.store.db.transaction(async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      await tx.execute(sql`SET LOCAL statement_timeout = '5000ms'`);
      const ledger = await tx.execute(sql`SELECT r.provider_key AS provider, l.currency, l.origin, CASE WHEN count(l.cost_minor)=count(*) THEN sum(l.cost_minor)::text END AS "costMinor", count(*)::int AS calls,
        CASE WHEN count(l.tokens_in)=count(*) THEN sum(l.tokens_in)::text END AS "tokensIn", CASE WHEN count(l.tokens_out)=count(*) THEN sum(l.tokens_out)::text END AS "tokensOut"
        FROM usage_ledger l JOIN usage_reservations r ON r.id=l.reservation_id AND r.workspace_id=l.workspace_id AND r.operation_id=l.operation_id
        WHERE l.workspace_id=${input.workspaceId} AND (${input.operationId ?? null}::text IS NULL OR l.operation_id=${input.operationId ?? null})
        GROUP BY r.provider_key,l.currency,l.origin ORDER BY r.provider_key,l.currency,l.origin LIMIT 201`);
      const reservations = await tx.execute(sql`SELECT r.provider_key AS provider, b.currency, r.state, sum(r.reserved_minor)::text AS "reservedMinor", count(*)::int AS calls
        FROM usage_reservations r JOIN operation_budgets b ON b.operation_id=r.operation_id AND b.workspace_id=r.workspace_id
        WHERE r.workspace_id=${input.workspaceId} AND r.state IN ('RESERVED','UNKNOWN') AND (${input.operationId ?? null}::text IS NULL OR r.operation_id=${input.operationId ?? null})
        GROUP BY r.provider_key,b.currency,r.state ORDER BY r.provider_key,b.currency,r.state LIMIT 201`);
      return providerSpendingSchema.parse({ workspaceId: input.workspaceId, items: ledger.rows.slice(0,200), reservations: reservations.rows.slice(0,200), truncated: ledger.rows.length>200||reservations.rows.length>200 });
    });
  }

  async runtime(actor: PlatformPrincipal, readiness: RuntimeReadiness) {
    await this.platform.requirePermission(actor, 'OPERATIONS', { action: 'READ_OPERATIONS_RUNTIME', targetType: 'RUNTIME' });
    return { checkedAt: new Date().toISOString(), overallState: readiness.overallState,
      components: [readiness.engine, readiness.orchestrator].map(component => ({ id: component.id, configured: component.configured, state: component.state, missing: component.missing, verifiedLive: component.verifiedLive, ...summarizeRuntimeComponent(component) })) };
  }

  async migrations(actor: PlatformPrincipal) {
    await this.platform.requirePermission(actor, 'OPERATIONS', { action: 'READ_MIGRATION_STATUS', targetType: 'RELEASE' });
    const source = await loadMigrations();
    return this.store.db.transaction(async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      await tx.execute(sql`SET LOCAL statement_timeout = '5000ms'`);
      const ledger = await tx.execute<{ name: string; checksum: string }>(sql`SELECT name,checksum FROM schema_migrations ORDER BY name`);
      const comparison = compareMigrationHistory(source, ledger.rows);
      return { status: comparison.pending.length || comparison.mismatches.length || comparison.unknownApplied.length || comparison.outOfOrder.length ? 'BLOCKED' : 'CURRENT',
        expected: source.length, applied: comparison.applied.length, pending: comparison.pending.map(row => row.name),
        mismatches: comparison.mismatches.map(row => row.name), unknownApplied: comparison.unknownApplied, outOfOrder: comparison.outOfOrder,
        checkedAt: new Date().toISOString() };
    });
  }

  async recover(actor: PlatformPrincipal, value: unknown) {
    await this.platform.requirePermission(actor, 'OPERATIONS', { action: 'BETA_RECOVERY', targetType: 'OPERATIONS_QUEUE' });
    let input: ReturnType<typeof operationsRecoverySchema.parse> | undefined;
    try {
      input = operationsRecoverySchema.parse(value);
      const command = input;
      return await this.store.db.transaction(async tx => {
        await tx.execute(sql`SET LOCAL statement_timeout = '5000ms'`);
        await tx.execute(sql`SET LOCAL lock_timeout = '2000ms'`);
        if (command.action === 'EXPEDITE_OUTBOX') {
          // Lock the same row as the dispatcher. Never reset DISPATCHING/UNKNOWN/FAILED or attempts.
          const [job] = await tx.select().from(outbox).where(and(eq(outbox.id, command.id), eq(outbox.workspaceId, command.workspaceId))).for('update').limit(1);
          const now = new Date().toISOString();
          if (!job || job.state !== 'PENDING' || job.attempts !== 0 || job.topic !== 'EXECUTE_STEP' || job.nextAttemptAt <= now) throw new DomainError('CONFLICT', 'Only future, never-dispatched pending jobs may be expedited');
          const revisionId = job.payload.planRevisionId, attemptId = job.payload.stepAttemptId;
          if (typeof revisionId !== 'string' || typeof attemptId !== 'string' || job.payload.operationId !== job.operationId || job.payload.idempotencyKey !== job.idempotencyKey) throw new DomainError('INVALID_STATE', 'Invalid dispatch scope');
          const [scope] = await tx.select({ id: operations.id }).from(operations).innerJoin(attempts, and(eq(attempts.operationId, operations.id), eq(attempts.id, attemptId), eq(attempts.revisionId, revisionId), eq(attempts.state, 'PENDING')))
            .where(and(eq(operations.id, job.operationId), eq(operations.workspaceId, command.workspaceId), eq(operations.currentRevisionId, revisionId), eq(operations.status, 'RUNNING'))).for('update', { of: operations }).limit(1);
          if (!scope) throw new DomainError('CONFLICT', 'Dispatch no longer belongs to an active mission revision');
          const [updated] = await tx.update(outbox).set({ nextAttemptAt: now }).where(and(eq(outbox.id, command.id), eq(outbox.state, 'PENDING'), eq(outbox.attempts, 0), gt(outbox.nextAttemptAt, now))).returning({ id: outbox.id });
          if (!updated) throw new DomainError('CONFLICT', 'Dispatch already changed');
        } else {
          await classifyRecoveryIncident(tx, { workspaceId: command.workspaceId, userId: actor.userId }, command.id, 'ESCALATE', command.reason);
        }
        await tx.insert(platformAdminAudit).values(this.platform.buildAuditRecord({ actor, action: command.action, targetType: command.action === 'EXPEDITE_OUTBOX' ? 'OUTBOX' : 'RECOVERY_INCIDENT', targetId: command.id, permission: 'OPERATIONS', outcome: 'SUCCESS', reason: command.reason, detail: { workspaceId: command.workspaceId } }));
        return { accepted: true, action: command.action, id: command.id };
      });
    } catch (error) {
      await this.platform.recordAudit({ actor, action: input?.action ?? 'BETA_RECOVERY', targetType: 'OPERATIONS_QUEUE', targetId: input?.id, permission: 'OPERATIONS', outcome: error instanceof DomainError ? 'DENIED' : 'ERROR', reason: error instanceof DomainError ? error.code : 'RECOVERY_REJECTED', detail: input ? { workspaceId: input.workspaceId } : null });
      throw error;
    }
  }
}

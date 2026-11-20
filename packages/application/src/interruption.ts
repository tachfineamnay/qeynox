import { and, eq, inArray, sql } from 'drizzle-orm';
import { DomainError, newId, transitionOperation, type ID, type Principal, type StepAttempt } from '@qeynox/domain';
import { QeyNoxStore, attempts, events, executions, operations, outbox, toolLedger } from '@qeynox/persistence';
import type { OrchestratorPort } from '@qeynox/orchestration';

/**
 * MISSION A06 — interruption, reconciliation and safe retry.
 *
 * Before A06 an operation could be *asked* to stop (`INTERRUPT_REQUESTED`) and then never move
 * again: no code path left that status, so the customer saw "Stop requested" forever and the
 * operation vanished from the attention list. There was also no way to retry after a failure.
 *
 * The hard rule this module enforces: **a stop is a request, never a claim.** QeyNox only reports
 * `INTERRUPTED` once it knows no step can still be running, and it never re-dispatches work whose
 * external outcome is unknown. Where the truth is unobtainable the state is left explicitly
 * unresolved (`INTERRUPTION_UNRESOLVED`) instead of being guessed in either direction.
 */

export interface InterruptionReconcilerOptions {
  /** Optional executor, used only to *request* cancellation. Never assumed to succeed. */
  readonly orchestrator?: Pick<OrchestratorPort, 'cancel'>;
}

export type ReconcileOutcome =
  /** Nothing was running, so the stop is confirmed. Operation is INTERRUPTED. */
  | { readonly result: 'INTERRUPTED'; readonly cancelledRuns: readonly string[]; readonly unauthorisedRuns: readonly string[] }
  /** A step is still running or a dispatch is ambiguous: the stop is NOT confirmed. */
  | { readonly result: 'STILL_ACTIVE'; readonly reasons: readonly string[] }
  /** The operation was not awaiting a stop request. */
  | { readonly result: 'NOOP'; readonly status: string };

export class InterruptionService {
  constructor(
    private readonly store: QeyNoxStore,
    private readonly options: InterruptionReconcilerOptions = {},
  ) {}

  private requireOperator(actor: Principal): void {
    if (!actor.roles.some(role => ['OWNER', 'ADMIN', 'OPERATOR'].includes(role))) {
      throw new DomainError('DENIED', 'Operator role required');
    }
  }

  /**
   * Requests cancellation of the executor runs linked to this operation.
   *
   * Returns what was actually requested. A failed cancellation is reported, never swallowed: the
   * caller must not conclude the work stopped. Onboarding of a run that Hatchet has already
   * finished is not an error we can distinguish from a transport failure, so it is reported as
   * unconfirmed rather than retried.
   */
  async requestCancellation(actor: Principal, operationId: ID): Promise<{ requested: readonly string[]; unconfirmed: readonly string[] }> {
    await this.store.getOperation(actor, operationId);
    const runs = await this.store.db
      .select()
      .from(executions)
      .where(eq(executions.operationId, operationId));
    const unsettled = runs.filter(run => {
      const status = (run.payload as { status?: string }).status;
      return status !== 'SUCCEEDED' && status !== 'FAILED' && status !== 'CANCELLED';
    });
    // A link without a run id cannot be cancelled, and pretending otherwise would hide a gap.
    const unconfirmed: string[] = unsettled.filter(run => !run.workflowRunId).map(run => run.id);
    const cancellable = unsettled.filter((run): run is typeof run & { workflowRunId: string } => Boolean(run.workflowRunId));
    if (!this.options.orchestrator) {
      return { requested: [], unconfirmed: [...unconfirmed, ...cancellable.map(run => run.workflowRunId)] };
    }
    const requested: string[] = [];
    for (const run of cancellable) {
      try {
        await this.options.orchestrator.cancel(run.workflowRunId);
        requested.push(run.workflowRunId);
      } catch {
        // Cancellation is best-effort by nature; reconciliation decides the business state.
        unconfirmed.push(run.workflowRunId);
      }
    }
    return { requested, unconfirmed };
  }

  /**
   * Decides whether a requested stop can be confirmed from persisted state.
   *
   * Confirmation requires all of:
   *  - no step attempt is PENDING or RUNNING;
   *  - no outbox intent is still awaiting dispatch, in flight, or of unknown dispatch outcome;
   *  - no tool execution has an UNKNOWN outcome (a remote write may have happened).
   */
  async reconcile(actor: Principal, operationId: ID, expectedVersion?: number): Promise<ReconcileOutcome> {
    // The operator check comes FIRST. Returning NOOP before it would let a member probe whether an
    // operation is awaiting a stop, which is operational information they are not entitled to.
    this.requireOperator(actor);
    const operation = await this.store.getOperation(actor, operationId);
    if (operation.status !== 'INTERRUPT_REQUESTED') {
      return { result: 'NOOP', status: operation.status };
    }
    const [attemptRows, pendingIntents, ambiguousTools] = await Promise.all([
      this.store.db.select().from(attempts).where(and(eq(attempts.operationId, operationId), inArray(attempts.state, ['PENDING', 'RUNNING']))),
      this.store.db.select().from(outbox).where(and(eq(outbox.operationId, operationId), inArray(outbox.state, ['PENDING', 'DISPATCHING', 'UNKNOWN']))),
      this.store.db.select().from(toolLedger).where(and(eq(toolLedger.operationId, operationId), eq(toolLedger.outcome, 'UNKNOWN'))),
    ]);

    const reasons: string[] = [];
    if (attemptRows.length) reasons.push('ATTEMPT_IN_FLIGHT');
    if (pendingIntents.some(item => item.state === 'PENDING')) reasons.push('DISPATCH_PENDING');
    if (pendingIntents.some(item => item.state === 'DISPATCHING')) reasons.push('DISPATCH_IN_FLIGHT');
    if (pendingIntents.some(item => item.state === 'UNKNOWN')) reasons.push('DISPATCH_UNCONFIRMED');
    if (ambiguousTools.length) reasons.push('TOOL_OUTCOME_UNKNOWN');

    const cancellation = await this.requestCancellation(actor, operationId);
    if (cancellation.unconfirmed.length) reasons.push('CANCELLATION_UNCONFIRMED');

    if (reasons.length) {
      // Record the attempt to reconcile without changing business status: the stop is still open.
      await this.store.writeEvent({
        workspaceId: actor.workspaceId, operationId, kind: 'INTERRUPTION_UNRESOLVED',
        data: { reasons: reasons.join(','), cancelledRuns: cancellation.requested.join(',') },
        occurredAt: new Date().toISOString(),
      });
      return { result: 'STILL_ACTIVE', reasons };
    }

    const now = new Date().toISOString();
    const reconciled = await this.store.db.transaction(async tx => {
      const [current] = await tx
        .select()
        .from(operations)
        .where(and(eq(operations.id, operationId), eq(operations.workspaceId, actor.workspaceId), eq(operations.status, 'INTERRUPT_REQUESTED')))
        .for('update')
        .limit(1);
      if (!current) return null;
      if (expectedVersion !== undefined && current.version !== expectedVersion) return null;
      const next = transitionOperation(current.payload, 'INTERRUPTED', now, current.version);
      const [changed] = await tx
        .update(operations)
        .set({ status: 'INTERRUPTED', version: next.version, payload: next, lastActivityAt: now })
        .where(and(eq(operations.id, operationId), eq(operations.version, current.version)))
        .returning({ id: operations.id });
      if (!changed) return null;
      // Any attempt left RUNNING by a lost worker is failed explicitly: we know it did not finish.
      const stranded = await tx
        .select()
        .from(attempts)
        .where(and(eq(attempts.operationId, operationId), eq(attempts.state, 'RUNNING')));
      for (const row of stranded) {
        const payload = row.payload as StepAttempt;
        await tx
          .update(attempts)
          .set({ state: 'FAILED', payload: { ...payload, state: 'FAILED', finishedAt: now, version: payload.version + 1, errorCode: 'INTERRUPTED' } })
          .where(and(eq(attempts.id, row.id), eq(attempts.state, 'RUNNING')));
      }
      const event = {
        id: newId(), workspaceId: actor.workspaceId, operationId, kind: 'OPERATION_INTERRUPTED',
        actorId: actor.userId, data: { cancelledRuns: cancellation.requested.join(','), strandedAttempts: String(stranded.length) },
        occurredAt: now, eventVersion: 1,
      };
      await tx.insert(events).values({ id: event.id, workspaceId: event.workspaceId, operationId, kind: event.kind, occurredAt: now, payload: event });
      return { version: next.version, stranded: stranded.length };
    });

    if (!reconciled) {
      // Someone else moved the operation; report the observed state rather than claiming success.
      const observed = await this.store.getOperation(actor, operationId);
      return { result: 'NOOP', status: observed.status };
    }
    return { result: 'INTERRUPTED', cancelledRuns: cancellation.requested, unauthorisedRuns: cancellation.unconfirmed };
  }

  /**
   * Re-dispatches the failed step attempt for a FAILED or INTERRUPTED operation.
   *
   * Safety conditions, all of which must hold:
   *  - the operation is FAILED or INTERRUPTED (never RUNNING, never an unresolved stop);
   *  - no dispatch intent for this operation has an unknown outcome;
   *  - no tool call has an unknown outcome, because a remote write may already have happened;
   *  - the current plan revision is still the sealed one.
   *
   * The retry reuses the *existing* attempt identity, so a retried delivery cannot create a second
   * attempt with different evidence attribution. It never replays an ambiguous dispatch.
   */
  async retry(actor: Principal, operationId: ID, expectedVersion: number, commandKey: string): Promise<{ attemptId: ID; alreadyAccepted: boolean }> {
    if (!commandKey || commandKey.length < 8) throw new DomainError('INVALID_INPUT', 'A command key is required');
    const operation = await this.store.getOperation(actor, operationId);
    if (operation.version !== expectedVersion) throw new DomainError('CONFLICT', 'Operation version changed');
    if (!['FAILED', 'INTERRUPTED'].includes(operation.status)) throw new DomainError('INVALID_STATE', 'Only a failed or interrupted operation can be retried');
    if (!operation.currentRevisionId) throw new DomainError('INVALID_STATE', 'Operation has no current revision');

    const [ambiguousIntent, ambiguousTool] = await Promise.all([
      this.store.db.select().from(outbox).where(and(eq(outbox.operationId, operationId), eq(outbox.state, 'UNKNOWN'))).limit(1),
      this.store.db.select().from(toolLedger).where(and(eq(toolLedger.operationId, operationId), eq(toolLedger.outcome, 'UNKNOWN'))).limit(1),
    ]);
    if (ambiguousIntent.length) throw new DomainError('UNKNOWN_OUTCOME', 'A previous dispatch outcome is unknown; reconcile it before retrying');
    if (ambiguousTool.length) throw new DomainError('UNKNOWN_OUTCOME', 'A tool write outcome is unknown; retrying could duplicate a remote side effect');

    const revisionId = operation.currentRevisionId;
    return this.store.db.transaction(async tx => {
      // Idempotency is checked inside the transaction so concurrent retries cannot both proceed.
      const [duplicate] = await tx
        .select()
        .from(outbox)
        .where(and(eq(outbox.workspaceId, actor.workspaceId), eq(outbox.operationId, operationId), eq(outbox.idempotencyKey, commandKey)))
        .limit(1);
      if (duplicate) {
        const payload = duplicate.payload as { stepAttemptId?: string };
        return { attemptId: payload.stepAttemptId as ID, alreadyAccepted: true };
      }
      const [current] = await tx
        .select()
        .from(operations)
        .where(and(eq(operations.id, operationId), eq(operations.workspaceId, actor.workspaceId), eq(operations.version, expectedVersion)))
        .for('update')
        .limit(1);
      if (!current) throw new DomainError('CONFLICT', 'Concurrent operation change');
      const [failedAttempt] = await tx
        .select()
        .from(attempts)
        .where(and(eq(attempts.operationId, operationId), eq(attempts.revisionId, revisionId), eq(attempts.state, 'FAILED')))
        .orderBy(sql`${attempts.sequence} desc`)
        .limit(1);
      if (!failedAttempt) throw new DomainError('INVALID_STATE', 'No failed attempt to retry in the current revision');
      const attempt = failedAttempt.payload as StepAttempt;
      const now = new Date().toISOString();
      const resumed: StepAttempt = { ...attempt, state: 'PENDING', startedAt: undefined, finishedAt: undefined, errorCode: undefined, version: attempt.version + 1 };
      await tx
        .update(attempts)
        .set({ state: 'PENDING', payload: resumed })
        .where(and(eq(attempts.id, attempt.id), eq(attempts.state, 'FAILED')));
      await tx.insert(outbox).values({
        id: newId(), workspaceId: actor.workspaceId, operationId, topic: 'EXECUTE_STEP', idempotencyKey: commandKey,
        payload: { operationId, planRevisionId: revisionId, stepAttemptId: attempt.id, idempotencyKey: commandKey },
        createdAt: now, nextAttemptAt: now,
      });
      // The lifecycle only permits FAILED/INTERRUPTED → READY → RUNNING, so a retry must pass
      // through READY. Skipping the intermediate state was an illegal transition, not a shortcut.
      const ready = transitionOperation(current.payload, 'READY', now, expectedVersion);
      const next = transitionOperation(ready, 'RUNNING', now, ready.version);
      await tx
        .update(operations)
        .set({ status: 'RUNNING', version: next.version, payload: next, lastActivityAt: now })
        .where(and(eq(operations.id, operationId), eq(operations.version, expectedVersion)));
      const event = {
        id: newId(), workspaceId: actor.workspaceId, operationId, kind: 'EXECUTION_RETRIED', actorId: actor.userId,
        data: { attemptId: attempt.id, priorErrorCode: attempt.errorCode ?? null }, occurredAt: now, eventVersion: 1,
      };
      await tx.insert(events).values({ id: event.id, workspaceId: event.workspaceId, operationId, kind: event.kind, occurredAt: now, payload: event });
      return { attemptId: attempt.id, alreadyAccepted: false };
    });
  }
}

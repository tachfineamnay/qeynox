import { and, desc, eq, inArray } from 'drizzle-orm';
import { DomainError, newId, type ID } from '@qeynox/domain';
import {
  betaExecutionAuthorizations, betaGrants, effectiveBetaStatus, events, quoteAcceptances, quotes,
  type BetaAuthorizationStatus, type BetaTransaction, type QeyNoxDatabase,
} from '@qeynox/persistence';
import type { CommercePolicy } from './commerce-mode';

/**
 * MISSION A21.03 — FREE BETA EXECUTION AUTHORIZATION.
 *
 * During the free beta (`QEYNOX_COMMERCE_MODE=BETA_FREE`) a workspace holding an ACTIVE beta grant
 * may execute an accepted, PRICED scope without paying. That permission is a separate,
 * non-financial record (`raas_beta_authorizations`), NOT a payment:
 *
 * - The quote, the published list price, the offer version, the terms acceptance and the scope hash
 *   are created and stored exactly as for a paid order. Nothing is discounted or rewritten. The
 *   authorization only records that the amount due now is 0.
 * - No `raas_payments` row, refund, invoice, checkout session or provider call is ever created. The
 *   order moves to `BETA_AUTHORIZED` (then `BETA_DELIVERED`), never to `AUTHORIZED`, `PAID` or
 *   `CAPTURED`. Payment-authorized states keep their meaning: money was really authorized.
 * - The authorization is bound to the exact workspace, operation, plan revision, quote, acceptance,
 *   order and scope hash, and to the beta grant that was ACTIVE when it was created. All of these
 *   bindings are checked again, with the linked grant's status and expiry, at execution start,
 *   retry, redo and result delivery. A revoked or expired grant, a later grant that replaces it, a
 *   changed plan revision or a commerce mode other than BETA_FREE all stop the work (fail closed).
 * - It grants nothing else. Consent, budgets and spend caps, ToolBroker permissions, runtime
 *   readiness, the beta launch gate (`admitMission`: quota and concurrency) and the human
 *   RESULT_REVIEW approval stay mandatory and are enforced by their own services, unchanged.
 */
export const BETA_ORDER_STATES = ['BETA_AUTHORIZED', 'BETA_DELIVERED'] as const;
export type BetaOrderState = (typeof BETA_ORDER_STATES)[number];
export function isBetaOrderState(state: string): state is BetaOrderState {
  return (BETA_ORDER_STATES as readonly string[]).includes(state);
}

export type BetaAuthorizationDenial =
  | 'BETA_MODE_DISABLED' | 'AUTHORIZATION_MISSING' | 'AUTHORIZATION_MISMATCH' | 'REVISION_CHANGED' | 'SCOPE_CHANGED'
  | 'ALREADY_DELIVERED' | 'NO_GRANT' | 'GRANT_NOT_ACTIVATED' | 'GRANT_EXPIRED' | 'GRANT_REVOKED';

/** Customer- and operator-facing description. `amountDueNowMinor` is the literal 0, never a computed value. */
export interface BetaAuthorizationView {
  readonly id: string;
  readonly basis: 'FREE_BETA';
  readonly grantId: string;
  readonly status: BetaAuthorizationStatus;
  readonly revisionId: string;
  readonly offerId: string;
  readonly offerVersion: number;
  readonly termsVersion: string;
  /** The published price of the accepted scope, unchanged. Informational: nothing is charged. */
  readonly listAmountMinor: number;
  readonly currency: string;
  readonly amountDueNowMinor: 0;
  readonly authorizedAt: string;
  readonly deliveredAt: string | null;
  /** Whether it authorizes execution and delivery right now (re-evaluated on every read). */
  readonly valid: boolean;
  readonly denial: BetaAuthorizationDenial | null;
}

type Executor = QeyNoxDatabase | BetaTransaction;
type AuthorizationRow = typeof betaExecutionAuthorizations.$inferSelect;
export interface BetaOrderRef {
  readonly id: string; readonly workspaceId: string; readonly operationId: string; readonly revisionId: string;
  readonly quoteId: string; readonly state: string; readonly amountMinor: number; readonly currency: string;
}
export type BetaPurpose = 'EXECUTION' | 'DELIVERY' | 'READ';
export type BetaEvaluation =
  | { readonly ok: true; readonly authorization: AuthorizationRow }
  | { readonly ok: false; readonly denial: BetaAuthorizationDenial; readonly authorization: AuthorizationRow | null };

function grantDenial(status: string): BetaAuthorizationDenial {
  if (status === 'REVOKED') return 'GRANT_REVOKED';
  if (status === 'EXPIRED') return 'GRANT_EXPIRED';
  return 'GRANT_NOT_ACTIVATED';
}

export function betaAuthorizationError(denial: BetaAuthorizationDenial, grantId: string | null, purpose: BetaPurpose): DomainError {
  const context: Record<string, string> = { reason: 'BETA_AUTHORIZATION_' + denial, purpose };
  if (grantId) context.grantId = grantId;
  return new DomainError('BETA_ACCESS_REQUIRED', 'Beta execution authorization does not allow ' + purpose.toLowerCase() + ': ' + denial, context);
}

export class BetaExecutionAuthorizer {
  constructor(private readonly policy: CommercePolicy) {}

  get enabled(): boolean { return this.policy.betaFree; }

  /**
   * The workspace's ACTIVE, unexpired grant, or the reason there is none. With `lock`, the live grant
   * row is held FOR SHARE until the caller's transaction ends: a concurrent revocation (FOR UPDATE)
   * waits, and a revocation that committed first makes the row stop matching (READ COMMITTED
   * re-check), so an authorization can never be created against a grant that is already revoked.
   */
  async eligibleGrant(executor: Executor, workspaceId: string, at: Date, lock: boolean): Promise<{ grantId: string } | { denial: BetaAuthorizationDenial }> {
    if (!this.policy.betaFree) return { denial: 'BETA_MODE_DISABLED' };
    const query = executor.select().from(betaGrants)
      .where(and(eq(betaGrants.workspaceId, workspaceId), inArray(betaGrants.status, ['INVITED', 'ACTIVE'])));
    const [grant] = await (lock ? query.for('share').limit(1) : query.limit(1));
    if (!grant) {
      const [latest] = await executor.select({ status: betaGrants.status }).from(betaGrants).where(eq(betaGrants.workspaceId, workspaceId))
        .orderBy(desc(betaGrants.createdAt), desc(betaGrants.id)).limit(1);
      return { denial: latest ? grantDenial(latest.status) : 'NO_GRANT' };
    }
    const status = effectiveBetaStatus(grant, at);
    return status === 'ACTIVE' ? { grantId: grant.id } : { denial: grantDenial(status) };
  }

  /**
   * Records the beta authorization for an order the caller has just inserted or locked in `tx`. The
   * caller has already verified the order is priced (amount > 0, not an explicitly free offer) and
   * that the plan revision is current. Returns null (and writes nothing) when the workspace is not
   * eligible, so the order stays PAYMENT_REQUIRED exactly as before A21.03.
   */
  async authorize(tx: BetaTransaction, input: {
    readonly actorUserId: string; readonly order: BetaOrderRef; readonly acceptanceId: string; readonly at: Date;
  }): Promise<AuthorizationRow | null> {
    const eligible = await this.eligibleGrant(tx, input.order.workspaceId, input.at, true);
    if ('denial' in eligible) return null;
    const [quote] = await tx.select().from(quotes).where(and(eq(quotes.id, input.order.quoteId), eq(quotes.workspaceId, input.order.workspaceId))).limit(1);
    const [acceptance] = await tx.select().from(quoteAcceptances).where(eq(quoteAcceptances.id, input.acceptanceId)).limit(1);
    if (!quote || !acceptance) throw new DomainError('INVALID_STATE', 'Accepted quote is missing');
    if (acceptance.quoteId !== quote.id || acceptance.scopeHash !== quote.scopeHash || acceptance.revisionId !== quote.revisionId
      || quote.operationId !== input.order.operationId || quote.revisionId !== input.order.revisionId
      || quote.amountMinor !== input.order.amountMinor || quote.currency !== input.order.currency) {
      throw new DomainError('CONFLICT', 'Order, quote and acceptance do not describe the same scope');
    }
    if (!(quote.amountMinor > 0)) throw new DomainError('INVALID_STATE', 'Only priced scopes need a beta authorization');
    const [row] = await tx.insert(betaExecutionAuthorizations).values({
      id: newId(), workspaceId: input.order.workspaceId, operationId: input.order.operationId, revisionId: input.order.revisionId,
      quoteId: quote.id, acceptanceId: acceptance.id, orderId: input.order.id, betaGrantId: eligible.grantId,
      scopeHash: quote.scopeHash, offerId: quote.offerId, offerVersion: quote.offerVersion, termsVersion: quote.termsVersion,
      listAmountMinor: quote.amountMinor, currency: quote.currency, amountDueNowMinor: 0, status: 'AUTHORIZED',
      authorizedBy: input.actorUserId, authorizedAt: input.at,
    }).returning();
    const occurredAt = input.at.toISOString();
    const event = {
      id: newId(), workspaceId: input.order.workspaceId as ID, operationId: input.order.operationId as ID, kind: 'BETA_EXECUTION_AUTHORIZED',
      actorId: input.actorUserId as ID,
      data: { orderId: input.order.id, authorizationId: row!.id, grantId: eligible.grantId, listAmountMinor: quote.amountMinor, currency: quote.currency, amountDueNowMinor: 0 },
      occurredAt, eventVersion: 1,
    };
    await tx.insert(events).values({ id: event.id, workspaceId: event.workspaceId, operationId: event.operationId, kind: event.kind, occurredAt, payload: event });
    return row!;
  }

  /**
   * Decides whether a beta order may execute (EXECUTION), be delivered (DELIVERY) or is reported as
   * currently valid (READ). Every binding is compared, not just the order state, so a row that was
   * tampered with or that belongs to another scope cannot authorize anything.
   */
  async evaluate(executor: Executor, input: {
    readonly order: BetaOrderRef; readonly currentRevisionId: string | null; readonly at: Date; readonly purpose: BetaPurpose; readonly lockGrant?: boolean;
  }): Promise<BetaEvaluation> {
    const { order } = input;
    const [authorization] = await executor.select().from(betaExecutionAuthorizations)
      .where(and(eq(betaExecutionAuthorizations.orderId, order.id), eq(betaExecutionAuthorizations.workspaceId, order.workspaceId))).limit(1);
    const deny = (denial: BetaAuthorizationDenial): BetaEvaluation => ({ ok: false, denial, authorization: authorization ?? null });
    if (!isBetaOrderState(order.state) || !authorization) return deny('AUTHORIZATION_MISSING');
    if (authorization.operationId !== order.operationId || authorization.revisionId !== order.revisionId || authorization.quoteId !== order.quoteId
      || authorization.listAmountMinor !== order.amountMinor || authorization.currency !== order.currency || authorization.amountDueNowMinor !== 0) {
      return deny('AUTHORIZATION_MISMATCH');
    }
    if (input.currentRevisionId !== authorization.revisionId) return deny('REVISION_CHANGED');
    const [quote] = await executor.select({ scopeHash: quotes.scopeHash, amountMinor: quotes.amountMinor, currency: quotes.currency, offerId: quotes.offerId, offerVersion: quotes.offerVersion })
      .from(quotes).where(and(eq(quotes.id, authorization.quoteId), eq(quotes.workspaceId, order.workspaceId))).limit(1);
    const [acceptance] = await executor.select({ scopeHash: quoteAcceptances.scopeHash, quoteId: quoteAcceptances.quoteId })
      .from(quoteAcceptances).where(eq(quoteAcceptances.id, authorization.acceptanceId)).limit(1);
    if (!quote || !acceptance || acceptance.quoteId !== authorization.quoteId || quote.scopeHash !== authorization.scopeHash || acceptance.scopeHash !== authorization.scopeHash
      || quote.amountMinor !== authorization.listAmountMinor || quote.currency !== authorization.currency
      || quote.offerId !== authorization.offerId || quote.offerVersion !== authorization.offerVersion) {
      return deny('SCOPE_CHANGED');
    }
    if (input.purpose !== 'READ' && (order.state !== 'BETA_AUTHORIZED' || authorization.status !== 'AUTHORIZED')) return deny('ALREADY_DELIVERED');
    if (!this.policy.betaFree) return deny('BETA_MODE_DISABLED');
    const grantQuery = executor.select().from(betaGrants).where(and(eq(betaGrants.id, authorization.betaGrantId), eq(betaGrants.workspaceId, order.workspaceId)));
    const [grant] = await (input.lockGrant ? grantQuery.for('share').limit(1) : grantQuery.limit(1));
    if (!grant) return deny('NO_GRANT');
    const status = effectiveBetaStatus(grant, input.at);
    if (status !== 'ACTIVE') return deny(grantDenial(status));
    return { ok: true, authorization };
  }

  async assert(executor: Executor, input: Parameters<BetaExecutionAuthorizer['evaluate']>[1]): Promise<AuthorizationRow> {
    const result = await this.evaluate(executor, input);
    if (!result.ok) throw betaAuthorizationError(result.denial, result.authorization?.betaGrantId ?? null, input.purpose);
    return result.authorization;
  }

  async view(executor: Executor, order: BetaOrderRef, currentRevisionId: string | null, at: Date): Promise<BetaAuthorizationView | null> {
    if (!isBetaOrderState(order.state)) return null;
    const result = await this.evaluate(executor, { order, currentRevisionId, at, purpose: order.state === 'BETA_AUTHORIZED' ? 'EXECUTION' : 'READ' });
    const row = result.authorization;
    if (!row) return null;
    return {
      id: row.id, basis: 'FREE_BETA', grantId: row.betaGrantId, status: row.status, revisionId: row.revisionId,
      offerId: row.offerId, offerVersion: row.offerVersion, termsVersion: row.termsVersion,
      listAmountMinor: row.listAmountMinor, currency: row.currency, amountDueNowMinor: 0,
      authorizedAt: row.authorizedAt.toISOString(), deliveredAt: row.deliveredAt ? row.deliveredAt.toISOString() : null,
      valid: result.ok && order.state === 'BETA_AUTHORIZED', denial: result.ok ? (order.state === 'BETA_AUTHORIZED' ? null : 'ALREADY_DELIVERED') : result.denial,
    };
  }

  /** Marks the authorization consumed by delivery, in the delivery transaction. */
  async markDelivered(tx: BetaTransaction, authorizationId: string, at: Date): Promise<void> {
    const updated = await tx.update(betaExecutionAuthorizations).set({ status: 'DELIVERED', deliveredAt: at })
      .where(and(eq(betaExecutionAuthorizations.id, authorizationId), eq(betaExecutionAuthorizations.status, 'AUTHORIZED')))
      .returning({ id: betaExecutionAuthorizations.id });
    if (updated.length !== 1) throw new DomainError('CONFLICT', 'Beta authorization changed concurrently');
  }
}

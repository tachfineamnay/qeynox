'use client';

import { useEffect, useState } from 'react';
import { useActionState } from 'react';
import { Feedback } from './ui';
import { startCheckout } from '../lib/plan-actions';
import { formatMoney } from '../lib/money';
import type { Locale } from '../lib/copy';

/**
 * MISSION A08 — customer payment status and recoverable checkout.
 *
 * The design rule is that every state is named and every state has a next step. Nothing here decides
 * whether a payment succeeded: the server tells the page what it recorded, and this component only
 * renders it. In particular, `returned=1` in the URL is treated as "the customer came back", not as
 * "the payment worked" — the page then shows whatever the server still records, which may legitimately
 * still be PENDING while the provider webhook is in flight.
 *
 * MISSION A21.01 — HARD PAYMENT FREEZE. When the server reports a `commerce` availability block, the
 * panel renders the frozen state for its mode and NEVER renders a checkout form: historical payment facts
 * (status, amounts, refunds) are shown read-only, and no resume/retry/pay action is offered. The server
 * refuses checkout regardless; hiding the action keeps the page from promising something it cannot do.
 */

type Status = 'CREATED' | 'REQUIRES_ACTION' | 'PROCESSING' | 'AUTHORIZED' | 'CAPTURED' | 'FAILED' | 'EXPIRED' | 'CANCELLED' | 'DISPUTED' | 'REFUNDED';

const copy = {
  en: {
    title: 'Payment',
    intro: 'One-time payment for this scoped deliverable. No subscription is created.',
    noOrder: 'Accept a quote before paying. No price is shown until a quote is accepted.',
    notConfigured: 'Payments are not configured in this environment. Nothing can be charged and execution stays blocked.',
    pay: 'Continue to secure checkout',
    resume: 'Resume checkout',
    retry: 'Try again',
    status: 'Status',
    amount: 'Amount',
    captured: 'Captured',
    refunded: 'Refunded',
    expires: 'Checkout expires',
    authorized: 'Payment authorized. Execution can proceed once the plan is launched.',
    awaiting: 'Waiting for the payment provider to confirm. This page does not treat the return as confirmation.',
    textFailed: 'The payment was declined. You can try again — no charge was made.',
    textExpired: 'The checkout expired before it was completed. You can start a new one.',
    textCancelled: 'The payment was cancelled. You can start a new one.',
    textDisputed: 'This payment is under dispute. Execution and delivery are blocked until it is resolved.',
    textRefunded: 'This payment has been refunded.',
    pending: 'The payment provider is still processing. You will not be charged twice.',
    noOverride: 'An authorized payment is required before any paid work begins. This page cannot bypass that.',
    providerIssue: 'The payment provider could not be reached for a status check. Your recorded state is unchanged.',
    forbidden: 'This account cannot change the payment for this mission.',
    frozenDisabled: 'Payments are currently disabled. Nothing can be charged, and paid work stays blocked.',
    frozenBeta: 'QeyNox is in free beta: no payment is taken. Checkout is closed, so paid offers cannot start during the beta.',
    frozenHistory: 'Recorded payment history is shown for reference only. It cannot be changed while payments are frozen.',
    frozenAction: 'Payments are frozen on the server. No checkout was started and nothing was charged.',
    states: {
      CREATED: 'Checkout created, not completed',
      REQUIRES_ACTION: 'Action required at the provider',
      PROCESSING: 'Processing',
      AUTHORIZED: 'Authorized',
      CAPTURED: 'Paid',
      FAILED: 'Declined',
      EXPIRED: 'Expired',
      CANCELLED: 'Cancelled',
      DISPUTED: 'Disputed',
      REFUNDED: 'Refunded',
    } as Record<Status, string>,
  },
  fr: {
    title: 'Paiement',
    intro: 'Paiement unique pour ce livrable délimité. Aucun abonnement n’est créé.',
    noOrder: 'Acceptez un devis avant de payer. Aucun prix n’est affiché tant qu’un devis n’est pas accepté.',
    notConfigured: 'Les paiements ne sont pas configurés dans cet environnement. Rien ne peut être débité et l’exécution reste bloquée.',
    pay: 'Continuer vers le paiement sécurisé',
    resume: 'Reprendre le paiement',
    retry: 'Réessayer',
    status: 'Statut',
    amount: 'Montant',
    captured: 'Encaissé',
    refunded: 'Remboursé',
    expires: 'Le paiement expire',
    authorized: 'Paiement autorisé. L’exécution peut commencer dès le lancement du plan.',
    awaiting: 'En attente de confirmation du prestataire de paiement. Cette page ne considère pas le retour comme une confirmation.',
    textFailed: 'Le paiement a été refusé. Vous pouvez réessayer — aucun débit n’a été effectué.',
    textExpired: 'Le paiement a expiré avant d’être finalisé. Vous pouvez en démarrer un nouveau.',
    textCancelled: 'Le paiement a été annulé. Vous pouvez en démarrer un nouveau.',
    textDisputed: 'Ce paiement fait l’objet d’une contestation. L’exécution et la livraison sont bloquées jusqu’à résolution.',
    textRefunded: 'Ce paiement a été remboursé.',
    pending: 'Le prestataire traite encore le paiement. Vous ne serez pas débité deux fois.',
    noOverride: 'Un paiement autorisé est nécessaire avant tout travail payant. Cette page ne peut pas contourner cette règle.',
    providerIssue: 'Le prestataire de paiement est injoignable pour une vérification. Votre état enregistré reste inchangé.',
    forbidden: 'Ce compte ne peut pas modifier le paiement de cette mission.',
    frozenDisabled: 'Les paiements sont actuellement désactivés. Rien ne peut être débité et le travail payant reste bloqué.',
    frozenBeta: 'QeyNox est en bêta gratuite : aucun paiement n’est encaissé. Le paiement en ligne est fermé, les offres payantes ne peuvent donc pas démarrer pendant la bêta.',
    frozenHistory: 'L’historique de paiement enregistré est affiché à titre indicatif. Il ne peut pas être modifié tant que les paiements sont gelés.',
    frozenAction: 'Les paiements sont gelés côté serveur. Aucun paiement n’a été démarré et rien n’a été débité.',
    states: {
      CREATED: 'Paiement créé, non finalisé',
      REQUIRES_ACTION: 'Action requise chez le prestataire',
      PROCESSING: 'En cours',
      AUTHORIZED: 'Autorisé',
      CAPTURED: 'Payé',
      FAILED: 'Refusé',
      EXPIRED: 'Expiré',
      CANCELLED: 'Annulé',
      DISPUTED: 'Contesté',
      REFUNDED: 'Remboursé',
    } as Record<Status, string>,
  },
} as const;

export interface PaymentPanelProps {
  lang: Locale;
  operationId: string;
  orderId: string | null;
  origin: string;
  payment: {
    id: string; status: Status; amountMinor: number; currency: string;
    capturedMinor: number; refundedMinor: number; checkoutUrl: string | null;
    expiresAt: string | null; failureCode: string | null;
  } | null;
  executionAuthorized: boolean;
  canStartCheckout: boolean;
  providerConfigured: boolean;
  /**
   * A21.01 server-authoritative commerce availability. When present, payments are frozen: the panel is
   * read-only and offers no checkout, whatever `canStartCheckout` says.
   */
  commerce: { mode: 'PAYMENTS_DISABLED' | 'BETA_FREE'; betaFree: boolean } | null;
  /** True when the customer arrived via the provider's success URL. Never treated as proof. */
  returned: boolean;
}

export function PaymentPanel(props: PaymentPanelProps) {
  const { lang, operationId, orderId, payment, executionAuthorized, canStartCheckout, providerConfigured, returned, origin, commerce } = props;
  const c = copy[lang];
  const [originValue, setOriginValue] = useState(origin);
  // Generated ONCE for this page load and kept for every retry. Regenerating it per render would give
  // each submit a new key, which is exactly what makes a double charge possible.
  const [idempotencyKeyValue] = useState(() => 'ui-' + operationId.slice(0, 12) + '-' + (orderId ?? 'none').slice(0, 12) + '-' + randomId());
  // The browser is the only place that knows the real public origin; it is never invented server-side.
  useEffect(() => { if (window.location.origin) setOriginValue(window.location.origin); }, []);
  const [state, action, pending] = useActionState(startCheckout, { code: '' });

  // A returned checkout redirects the browser to the hosted page. This is navigation, not proof.
  useEffect(() => {
    if (state.code === 'OK' && state.checkoutUrl) window.location.assign(state.checkoutUrl);
  }, [state]);

  if (commerce) {
    return (
      <div className="pay-panel" data-commerce-mode={commerce.mode}>
        <p className="pay-state pay-state-blocked" role="status">{commerce.betaFree ? c.frozenBeta : c.frozenDisabled}</p>
        {payment ? (
          <>
            <dl className="pay-facts">
              <div><dt>{c.status}</dt><dd><span className="pay-state pay-state-neutral" data-status={payment.status}>{c.states[payment.status]}</span></dd></div>
              <div><dt>{c.amount}</dt><dd>{formatMoney(payment.amountMinor, payment.currency, lang)}</dd></div>
              {payment.capturedMinor > 0 ? <div><dt>{c.captured}</dt><dd>{formatMoney(payment.capturedMinor, payment.currency, lang)}</dd></div> : null}
              {payment.refundedMinor > 0 ? <div><dt>{c.refunded}</dt><dd>{formatMoney(payment.refundedMinor, payment.currency, lang)}</dd></div> : null}
            </dl>
            <p className="muted">{c.frozenHistory}</p>
          </>
        ) : null}
        {executionAuthorized ? <p className="qx-ready">{c.authorized}</p> : <p className="muted">{c.noOverride}</p>}
      </div>
    );
  }

  if (!providerConfigured) {
    return (
      <div className="pay-panel">
        <p className="pay-state pay-state-blocked" role="status">{c.notConfigured}</p>
        <p className="muted">{c.noOverride}</p>
      </div>
    );
  }

  if (!orderId || !payment) {
    return <p className="muted">{c.noOrder}</p>;
  }

  const status = payment.status;
  const detail: string =
    executionAuthorized || status === 'AUTHORIZED' || status === 'CAPTURED' ? c.authorized
      : status === 'DISPUTED' ? c.textDisputed
        : status === 'REFUNDED' ? c.textRefunded
          : status === 'FAILED' ? c.textFailed
            : status === 'EXPIRED' ? c.textExpired
              : status === 'CANCELLED' ? c.textCancelled
                : status === 'PROCESSING' ? c.pending
                  : c.awaiting;

  const tone = executionAuthorized ? 'ok' : status === 'FAILED' || status === 'DISPUTED' ? 'bad' : status === 'EXPIRED' || status === 'CANCELLED' ? 'neutral' : 'wait';
  const canPay = canStartCheckout && (status === 'FAILED' || status === 'EXPIRED' || status === 'CANCELLED' || status === 'CREATED' || status === 'REQUIRES_ACTION');
  const label = status === 'CREATED' || status === 'REQUIRES_ACTION' ? c.resume : c.retry;

  return (
    <div className="pay-panel">
      <dl className="pay-facts">
        <div><dt>{c.status}</dt><dd><span className={'pay-state pay-state-' + tone} data-status={status}>{c.states[status]}</span></dd></div>
        <div><dt>{c.amount}</dt><dd>{formatMoney(payment.amountMinor, payment.currency, lang)}</dd></div>
        {payment.capturedMinor > 0 ? <div><dt>{c.captured}</dt><dd>{formatMoney(payment.capturedMinor, payment.currency, lang)}</dd></div> : null}
        {payment.refundedMinor > 0 ? <div><dt>{c.refunded}</dt><dd>{formatMoney(payment.refundedMinor, payment.currency, lang)}</dd></div> : null}
        {payment.expiresAt && (status === 'CREATED' || status === 'REQUIRES_ACTION') ? <div><dt>{c.expires}</dt><dd><time dateTime={payment.expiresAt}>{payment.expiresAt}</time></dd></div> : null}
      </dl>

      {/* The returned=1 marker changes only the wording, never the recorded state. */}
      {returned && !executionAuthorized ? <p className="pay-awaiting" role="status">{c.awaiting}</p> : null}
      <p className={tone === 'ok' ? 'qx-ready' : 'muted'}>{detail}</p>
      {payment.failureCode ? <p className="muted"><code>{payment.failureCode}</code></p> : null}

      {canPay ? (
        <form action={action} className="pay-form">
          <input type="hidden" name="operationId" value={operationId} />
          <input type="hidden" name="orderId" value={orderId} />
          <input type="hidden" name="locale" value={lang} />
          <input type="hidden" name="origin" value={originValue} />
          {/* Generated once per page load and kept across retries: a double submit cannot double-charge. */}
          <input type="hidden" name="idempotencyKey" value={idempotencyKeyValue} />
          <button type="submit" disabled={pending}>{pending ? (lang === 'fr' ? 'Redirection…' : 'Redirecting…') : label}</button>
        </form>
      ) : null}

      {state.code && state.code !== 'OK' ? <Feedback error title={message(lang, state.code)} /> : null}
      <p className="muted qx-hint">{c.noOverride}</p>
    </div>
  );
}

/** Random enough to distinguish attempts; the server enforces uniqueness, this only needs to differ. */
function randomId(): string {
  return globalThis.crypto?.randomUUID?.() ?? String(Math.random()).slice(2, 18);
}

function message(lang: Locale, code: string): string {
  const c = copy[lang];
  if (code === 'PAYMENTS_FROZEN') return c.frozenAction;
  if (code === 'PAYMENT_NOT_CONFIGURED') return c.notConfigured;
  if (code === 'DENIED' || code === 'NOT_FOUND') return c.forbidden;
  return lang === 'fr' ? 'Le paiement n’a pas pu démarrer (' + code + ').' : 'Checkout could not start (' + code + ').';
}

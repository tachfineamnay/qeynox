import { z } from 'zod';
import type { Locale } from './copy';

/**
 * MISSION A21.06 — authenticated "resend verification e-mail".
 *
 * The web calls `POST /v1/identity/verification/resend` with the session only (no body): the API
 * derives the recipient from the signed-in identity. The UI renders exactly the server's outcome and
 * never upgrades a non-accepted outcome into "sent".
 */
export const verificationResendOutcomes = ['ACCEPTED', 'NOT_CONFIGURED', 'DELIVERY_FAILED', 'ALREADY_VERIFIED'] as const;
export type VerificationResendOutcome = (typeof verificationResendOutcomes)[number];
/** UI states: the four server outcomes plus throttling (HTTP 429) and an unknown/failed request. */
export type VerificationResendView = VerificationResendOutcome | 'TOO_MANY_REQUESTS' | 'UNKNOWN';

export const verificationResendSchema = z.object({
  outcome: z.enum(verificationResendOutcomes),
  sent: z.boolean(),
  issued: z.boolean(),
  notSentReason: z.string().nullable(),
}).refine(result => result.sent === (result.outcome === 'ACCEPTED'));

/** Maps a successful API body to a UI state; a malformed or inconsistent body is UNKNOWN, never success. */
export function resendViewFromBody(value: unknown): VerificationResendView {
  const parsed = verificationResendSchema.safeParse(value);
  return parsed.success ? parsed.data.outcome : 'UNKNOWN';
}

/** Maps an API error code to a UI state. */
export function resendViewFromError(code: string): VerificationResendView {
  return code === 'BUDGET_EXHAUSTED' ? 'TOO_MANY_REQUESTS' : 'UNKNOWN';
}

export interface VerificationResendCopy {
  readonly title: Record<VerificationResendView, string>;
  readonly body: Record<VerificationResendView, string>;
}

export const verificationResendCopy: Record<Locale, VerificationResendCopy> = {
  en: {
    title: {
      ACCEPTED: 'Confirmation e-mail accepted by our e-mail provider',
      NOT_CONFIGURED: 'E-mail sending is not configured',
      DELIVERY_FAILED: 'The confirmation e-mail could not be delivered',
      ALREADY_VERIFIED: 'Your e-mail address is already confirmed',
      TOO_MANY_REQUESTS: 'Too many requests',
      UNKNOWN: 'The request could not be completed',
    },
    body: {
      ACCEPTED: 'Check your inbox and spam folder. The link works once and expires; any earlier link no longer works.',
      NOT_CONFIGURED: 'No e-mail provider is configured on this deployment, so no confirmation e-mail was sent and no new link was created.',
      DELIVERY_FAILED: 'The e-mail provider did not accept the message, so nothing was delivered. Please try again in a few minutes.',
      ALREADY_VERIFIED: 'No e-mail was sent. Reload this page to see the confirmed status.',
      TOO_MANY_REQUESTS: 'You have asked for several confirmation e-mails recently. Please wait up to 15 minutes before trying again.',
      UNKNOWN: 'We could not confirm whether an e-mail was sent. Wait a moment, then check your inbox before trying again.',
    },
  },
  fr: {
    title: {
      ACCEPTED: 'E-mail de confirmation accepté par notre fournisseur d’e-mail',
      NOT_CONFIGURED: 'L’envoi d’e-mails n’est pas configuré',
      DELIVERY_FAILED: 'L’e-mail de confirmation n’a pas pu être livré',
      ALREADY_VERIFIED: 'Votre adresse e-mail est déjà confirmée',
      TOO_MANY_REQUESTS: 'Trop de demandes',
      UNKNOWN: 'La demande n’a pas abouti',
    },
    body: {
      ACCEPTED: 'Consultez votre boîte de réception et vos indésirables. Le lien ne fonctionne qu’une fois et expire ; tout lien précédent ne fonctionne plus.',
      NOT_CONFIGURED: 'Aucun fournisseur d’e-mail n’est configuré sur ce déploiement : aucun e-mail de confirmation n’a été envoyé et aucun nouveau lien n’a été créé.',
      DELIVERY_FAILED: 'Le fournisseur d’e-mail n’a pas accepté le message : rien n’a été livré. Veuillez réessayer dans quelques minutes.',
      ALREADY_VERIFIED: 'Aucun e-mail n’a été envoyé. Rechargez cette page pour voir le statut confirmé.',
      TOO_MANY_REQUESTS: 'Vous avez demandé plusieurs e-mails de confirmation récemment. Veuillez patienter jusqu’à 15 minutes avant de réessayer.',
      UNKNOWN: 'Nous n’avons pas pu confirmer l’envoi d’un e-mail. Patientez un instant, puis vérifiez votre boîte de réception avant de réessayer.',
    },
  },
};

/** Failures are announced as alerts; informational outcomes as status (text, not colour, carries meaning). */
export function resendIsError(view: VerificationResendView): boolean {
  return view === 'DELIVERY_FAILED' || view === 'TOO_MANY_REQUESTS' || view === 'UNKNOWN';
}

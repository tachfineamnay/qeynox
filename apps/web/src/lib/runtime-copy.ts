import { z } from 'zod';
import type { Locale } from './locales';

/**
 * MISSION A21.07 — customer-facing runtime verification states.
 *
 * The API reports, per runtime component (Hermes agent runtime, Hatchet workflow executor), the
 * component's own live-check status. Nothing here infers a state: an absent or malformed summary
 * reads as NOT_PROBED, never as verified. All copy is EN/FR and lives here, not in components.
 */
export const runtimeVerificationStatusSchema = z.enum(['NOT_CONFIGURED', 'NOT_PROBED', 'VERIFIED', 'FAILED', 'STALE', 'TARGET_CHANGED']);
export const runtimeProbeFailureSchema = z.enum([
  'TIMEOUT', 'UNREACHABLE', 'UNHEALTHY', 'AUTH_REJECTED', 'IDENTITY_MISMATCH', 'ISOLATION_NOT_EVIDENCED', 'MODEL_NOT_ADVERTISED', 'INVALID_RESPONSE', 'PROBE_ERROR',
]);

const NOT_PROBED = { status: 'NOT_PROBED' as const, failure: null, checkedAt: null, expiresAt: null };

export const runtimeComponentSummarySchema = z.object({
  status: runtimeVerificationStatusSchema,
  failure: runtimeProbeFailureSchema.nullable().catch(null),
  checkedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
}).catch(NOT_PROBED);
export type RuntimeComponentSummary = z.infer<typeof runtimeComponentSummarySchema>;

/** Optional on the wire (older API); absent means "no evidence", never "verified". */
export const optionalRuntimeSummary = runtimeComponentSummarySchema.optional().transform(value => value ?? NOT_PROBED);

type Status = z.infer<typeof runtimeVerificationStatusSchema>;
type Failure = z.infer<typeof runtimeProbeFailureSchema>;

const copy: Record<Locale, {
  engine: string;
  orchestrator: string;
  status: Record<Status, string>;
  failure: Record<Failure, string>;
  checked: (when: string) => string;
  validUntil: (when: string) => string;
}> = {
  en: {
    engine: 'Agent runtime (Hermes)',
    orchestrator: 'Workflow executor (Hatchet)',
    status: {
      VERIFIED: 'Verified by a live check',
      NOT_PROBED: 'Not yet verified by a live check',
      STALE: 'Verification expired, waiting for a new live check',
      TARGET_CHANGED: 'Configuration changed, must be verified again',
      FAILED: 'Unavailable: the last live check failed',
      NOT_CONFIGURED: 'Not configured on this deployment',
    },
    failure: {
      TIMEOUT: 'it did not answer in time',
      UNREACHABLE: 'it could not be reached',
      UNHEALTHY: 'it reported itself unhealthy',
      AUTH_REJECTED: 'it refused the configured credentials',
      IDENTITY_MISMATCH: 'it did not prove its identity',
      ISOLATION_NOT_EVIDENCED: 'tool isolation could not be confirmed',
      MODEL_NOT_ADVERTISED: 'the configured model is not offered',
      INVALID_RESPONSE: 'it answered in an unexpected format',
      PROBE_ERROR: 'the check could not complete',
    },
    checked: when => 'checked ' + when,
    validUntil: when => 'valid until ' + when,
  },
  fr: {
    engine: 'Moteur d’agents (Hermes)',
    orchestrator: 'Exécuteur de workflows (Hatchet)',
    status: {
      VERIFIED: 'Vérifié par un contrôle en direct',
      NOT_PROBED: 'Pas encore vérifié par un contrôle en direct',
      STALE: 'Vérification expirée, nouveau contrôle en attente',
      TARGET_CHANGED: 'Configuration modifiée, nouvelle vérification requise',
      FAILED: 'Indisponible : le dernier contrôle a échoué',
      NOT_CONFIGURED: 'Non configuré sur ce déploiement',
    },
    failure: {
      TIMEOUT: 'il n’a pas répondu à temps',
      UNREACHABLE: 'il était injoignable',
      UNHEALTHY: 'il s’est déclaré en mauvais état',
      AUTH_REJECTED: 'il a refusé les identifiants configurés',
      IDENTITY_MISMATCH: 'il n’a pas prouvé son identité',
      ISOLATION_NOT_EVIDENCED: 'l’isolation des outils n’a pas pu être confirmée',
      MODEL_NOT_ADVERTISED: 'le modèle configuré n’est pas proposé',
      INVALID_RESPONSE: 'il a répondu dans un format inattendu',
      PROBE_ERROR: 'le contrôle n’a pas pu aboutir',
    },
    checked: when => 'contrôlé le ' + when,
    validUntil: when => 'valable jusqu’au ' + when,
  },
};

function when(lang: Locale, value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(date) + ' UTC'
    : null;
}

export function runtimeComponentLabel(lang: Locale, component: 'engine' | 'orchestrator'): string {
  return copy[lang][component];
}

/** One sentence describing a component's live verification, e.g. "Unavailable: … (it did not answer in time) · checked …". */
export function runtimeComponentText(lang: Locale, summary: RuntimeComponentSummary): string {
  const c = copy[lang];
  const parts = [c.status[summary.status] + (summary.status === 'FAILED' && summary.failure ? ' (' + c.failure[summary.failure] + ')' : '')];
  const checked = when(lang, summary.checkedAt);
  if (checked && summary.status !== 'NOT_CONFIGURED' && summary.status !== 'NOT_PROBED') parts.push(c.checked(checked));
  const until = when(lang, summary.expiresAt);
  if (until && summary.status === 'VERIFIED') parts.push(c.validUntil(until));
  return parts.join(' · ');
}

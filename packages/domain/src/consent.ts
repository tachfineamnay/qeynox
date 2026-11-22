import { DomainError } from './errors';
import type { Consent, UserContext } from './entities';

/** Consent timestamps must carry a timezone; ambiguous/local/invalid expirations fail closed. */
export function isConsentActive(consent: Pick<Consent, 'revokedAt' | 'expiresAt'>, now: string): boolean {
  const current = Date.parse(now);
  if (consent.revokedAt !== undefined || !Number.isFinite(current)) return false;
  if (consent.expiresAt === undefined) return true;
  if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(consent.expiresAt)) return false;
  const expiry = Date.parse(consent.expiresAt);
  if (!Number.isFinite(expiry) || expiry <= current) return false;
  // Date.parse normalizes impossible calendar days (e.g. February 30); do not grant them.
  const day = consent.expiresAt.slice(0, 10);
  const parsedDay = new Date(day + 'T00:00:00.000Z');
  return Number.isFinite(parsedDay.getTime()) && parsedDay.toISOString().slice(0, 10) === day;
}

export function assertConsent(consent: Consent | undefined, scope: string, userId: string, workspaceId: string, now: string): void {
  if (!consent || consent.userId !== userId || consent.workspaceId !== workspaceId ||
      !isConsentActive(consent, now) || !consent.scopes.includes(scope)) {
    throw new DomainError('DENIED', 'Context consent is absent or expired');
  }
}

export function contextSubset(items: readonly UserContext[], consents: readonly Consent[], scopes: readonly string[], now: string): readonly UserContext[] {
  return items.filter(item => !item.deletedAt && scopes.some(scope => {
    const consent = consents.find(c => c.id === item.consentId);
    try { assertConsent(consent, scope, item.ownerUserId, item.workspaceId, now); return true; }
    catch { return false; }
  }));
}

import { DomainError } from './errors';
import type { Consent, UserContext } from './entities';

export function assertConsent(consent: Consent | undefined, scope: string, userId: string, workspaceId: string, now: string): void {
  if (!consent || consent.userId !== userId || consent.workspaceId !== workspaceId ||
      consent.revokedAt || (consent.expiresAt && consent.expiresAt <= now) || !consent.scopes.includes(scope)) {
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

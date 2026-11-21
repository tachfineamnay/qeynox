import type { BetaGrantStatus } from './types';

/** A21.02 — presentation helpers shared by the beta pages (no business decision is made here). */
export function betaTone(status: BetaGrantStatus): 'success' | 'warning' | 'danger' | 'neutral' {
  return status === 'ACTIVE' ? 'success' : status === 'INVITED' ? 'warning' : status === 'REVOKED' ? 'danger' : 'neutral';
}
export function money(minor: number, currency: string, lang: string): string {
  try { return (minor / 100).toLocaleString(lang, { style: 'currency', currency }); }
  catch { return String(minor) + ' ' + currency + ' (minor)'; }
}

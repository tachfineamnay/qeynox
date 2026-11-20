/**
 * Money formatting for both server and client components.
 *
 * Kept out of `plan.ts` on purpose: that module is `server-only`, and the payment panel is an
 * interactive client component that must format an amount without pulling server code into the bundle.
 * Amounts are integer minor units everywhere; only this function converts for display.
 */
export function formatMoney(minor: number | null, currency: string | null, lang: 'en' | 'fr'): string {
  if (minor === null || !currency) return '—';
  try {
    return new Intl.NumberFormat(lang, { style: 'currency', currency, maximumFractionDigits: 2 }).format(minor / 100);
  } catch {
    return minor / 100 + ' ' + currency;
  }
}

/**
 * MISSION A11 — single registry of interface locales.
 *
 * SUPPORTED_LOCALES is everything routing, metadata, the sitemap and the app shell accept.
 * PENDING_LOCALES documents locales that are under preparation. They are deliberately NOT
 * routable: no catalog exists for them, and reviewing a complete translation is a precondition
 * for adding one. Never add a locale here without its reviewed catalog in lib/copy.ts (and the
 * matching catalogs for public-content, mission-copy and flow-copy).
 *
 * The translation architecture is documented in docs/design/I18N.md.
 */
export const SUPPORTED_LOCALES = ['en', 'fr'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

/** Locales intentionally absent from routing until reviewed catalogs land. */
export const PENDING_LOCALES = ['es', 'de'] as const;
export type PendingLocale = (typeof PENDING_LOCALES)[number];

export function isSupportedLocale(value: string): value is Locale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

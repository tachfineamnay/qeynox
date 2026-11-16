import type { Locale } from './copy';

/** UTC timestamps are rendered explicitly as UTC, matching the existing mission surface. */
export function stamp(lang: Locale, value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(date) + ' UTC';
}

export function statusLabel(labels: Record<string, string>, value: string): string {
  return labels[value] ?? value;
}

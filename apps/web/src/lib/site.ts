import type { Metadata } from 'next';
import type { Locale } from './copy';

/**
 * Public site origin. The existing qeynox.io routing is not modified: this value is only used for
 * canonical URLs, hreflang and sitemap entries. Override with QEYNOX_PUBLIC_URL in deployment.
 */
export const SITE_URL = (process.env.QEYNOX_PUBLIC_URL ?? 'https://qeynox.io').replace(/\/+$/, '');
export const SITE_NAME = 'QeyNox';

export interface PublicRoute {
  readonly key: string;
  readonly path: string;
  readonly changeFrequency: 'weekly' | 'monthly' | 'yearly';
  readonly priority: number;
}

/** Indexable public pages only. Application routes are deliberately excluded. */
export const PUBLIC_ROUTES: readonly PublicRoute[] = [
  { key: 'home', path: '', changeFrequency: 'monthly', priority: 1 },
  { key: 'howItWorks', path: 'how-it-works', changeFrequency: 'monthly', priority: 0.8 },
  { key: 'manifesto', path: 'manifesto', changeFrequency: 'monthly', priority: 0.7 },
  { key: 'contact', path: 'contact', changeFrequency: 'yearly', priority: 0.5 },
  { key: 'legalNotice', path: 'legal/notice', changeFrequency: 'yearly', priority: 0.3 },
  { key: 'privacy', path: 'legal/privacy', changeFrequency: 'yearly', priority: 0.3 },
  { key: 'terms', path: 'legal/terms', changeFrequency: 'yearly', priority: 0.3 },
  { key: 'cookies', path: 'legal/cookies', changeFrequency: 'yearly', priority: 0.3 },
];

export function publicPath(lang: Locale, path = ''): string {
  return '/' + lang + (path.length ? '/' + path : '');
}

export function absoluteUrl(lang: Locale, path = ''): string {
  return SITE_URL + publicPath(lang, path);
}

/** Unique title, description, canonical, hreflang and Open Graph metadata for a public page. */
export function pageMetadata(lang: Locale, path: string, title: string, description: string): Metadata {
  const canonical = absoluteUrl(lang, path);
  return {
    title: { absolute: title },
    description,
    alternates: {
      canonical,
      languages: {
        en: absoluteUrl('en', path),
        fr: absoluteUrl('fr', path),
        'x-default': absoluteUrl('en', path),
      },
    },
    openGraph: {
      title,
      description,
      url: canonical,
      siteName: SITE_NAME,
      locale: lang === 'fr' ? 'fr_FR' : 'en_US',
      type: 'website',
    },
    twitter: { card: 'summary', title, description },
  };
}

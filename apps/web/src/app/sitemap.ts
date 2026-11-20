import type { MetadataRoute } from 'next';
import { PUBLIC_ROUTES, absoluteUrl } from '../lib/site';
import { SUPPORTED_LOCALES } from '../lib/locales';

/** Sitemap for indexable public pages only, with alternates for every supported locale. */
export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();
  return PUBLIC_ROUTES.flatMap(route => SUPPORTED_LOCALES.map(lang => ({
    url: absoluteUrl(lang, route.path),
    lastModified,
    changeFrequency: route.changeFrequency,
    priority: route.priority,
    alternates: {
      languages: Object.fromEntries(SUPPORTED_LOCALES.map(l => [l, absoluteUrl(l, route.path)])),
    },
  })));
}

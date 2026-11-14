import type { MetadataRoute } from 'next';
import { PUBLIC_ROUTES, absoluteUrl } from '../lib/site';

/** Sitemap for indexable public pages only, with EN/FR alternates. */
export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();
  const languages = ['en', 'fr'] as const;
  return PUBLIC_ROUTES.flatMap(route => languages.map(lang => ({
    url: absoluteUrl(lang, route.path),
    lastModified,
    changeFrequency: route.changeFrequency,
    priority: route.priority,
    alternates: {
      languages: {
        en: absoluteUrl('en', route.path),
        fr: absoluteUrl('fr', route.path),
      },
    },
  })));
}

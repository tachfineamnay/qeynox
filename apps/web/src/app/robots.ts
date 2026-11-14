import type { MetadataRoute } from 'next';
import { SITE_URL } from '../lib/site';

/** Public pages are crawlable; authenticated and administration routes are not. */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{
      userAgent: '*',
      allow: '/',
      disallow: ['/account', '/mydash', '/missions', '/soul', '/support', '/capabilities', '/admin', '/api/', '/*/account', '/*/mydash', '/*/missions', '/*/soul', '/*/support', '/*/capabilities'],
    }],
    sitemap: SITE_URL + '/sitemap.xml',
  };
}

import type { NextConfig } from 'next';

/**
 * QeyNox Control is served under /admin on the existing qeynox.io domain.
 * Next.js basePath owns both page routes and /_next assets, so the reverse proxy only needs one
 * rule: https://qeynox.io/admin -> qeynox-control:3001 (path preserved). Web routes and the web
 * app's /_next namespace stay untouched.
 */
const config: NextConfig = {
  basePath: '/admin',
  poweredByHeader: false,
  async redirects() {
    return [{ source: '/', destination: '/en', permanent: false }];
  },
};
export default config;

import type { NextConfig } from 'next';
const config: NextConfig = {
  poweredByHeader: false,
  async redirects() { return [{ source: '/', destination: '/admin/en', permanent: false }]; },
};
export default config;

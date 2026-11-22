import type { NextConfig } from 'next';
const config: NextConfig = {
  deploymentId: process.env.QEYNOX_RELEASE_SHA,
  transpilePackages: ['@qeynox/contracts'],
  poweredByHeader: false,
  async redirects() { return [{ source: '/', destination: '/en', permanent: false }]; },
};
export default config;

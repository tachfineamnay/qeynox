import type { NextConfig } from 'next';
const config: NextConfig = { transpilePackages: ['@qeynox/contracts'], poweredByHeader: false, async redirects() { return [{ source: '/', destination: '/en', permanent: false }]; } };
export default config;

import { writeFileSync } from 'node:fs';
const sha = process.env.QEYNOX_RELEASE_SHA;
const version = process.env.QEYNOX_RELEASE_VERSION;
if (!/^[a-f0-9]{40}$/.test(sha ?? '') || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(version ?? '')) {
  console.error('Build requires full QEYNOX_RELEASE_SHA and explicit QEYNOX_RELEASE_VERSION');
  process.exit(1);
}
writeFileSync('.qeynox-release.json', JSON.stringify({ sha, version }) + '\n');

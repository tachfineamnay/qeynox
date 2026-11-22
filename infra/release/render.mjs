// Renders local desired settings only; deliberately no Coolify mutation/deploy client.
import { readFileSync } from 'node:fs';
import { required, optional } from './contract.mjs';
const sha = process.argv[2], version = process.argv[3];
if (!/^[a-f0-9]{40}$/.test(sha ?? '') || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(version ?? '')) {
  console.error('Usage: pnpm release:render <full-reviewed-sha> <release-version>'); process.exit(1);
}
const manifest = JSON.parse(readFileSync(new URL('../coolify/release.json', import.meta.url), 'utf8'));
for (const [role, app] of Object.entries(manifest.applications)) {
  app.git_commit_sha = sha;
  app.build_argument_values = { QEYNOX_RELEASE_SHA: sha, QEYNOX_RELEASE_VERSION: version };
  app.runtime_policy = { NODE_ENV: 'production', QEYNOX_RELEASE_SHA: sha, QEYNOX_RELEASE_VERSION: version, QEYNOX_COMMERCE_MODE: 'BETA_FREE', QEYNOX_REGISTRATION_MODE: 'INVITE_ONLY' };
  app.required_runtime_keys = required[role];
  app.optional_runtime_keys = [...(['api', 'worker'].includes(role) ? optional.backend : []), ...(optional[role] ?? [])];
}
console.log(JSON.stringify(manifest, null, 2));

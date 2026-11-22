import { readFileSync, statSync } from 'node:fs';
const role = process.argv[2];
try {
  const image = JSON.parse(readFileSync('/workspace/.qeynox-release.json', 'utf8'));
  if (role === 'worker') {
    const file = '/tmp/qeynox-worker-health.json';
    const live = JSON.parse(readFileSync(file, 'utf8'));
    if (Date.now() - statSync(file).mtimeMs > 60_000 || live.sha !== image.sha || live.version !== image.version) throw new Error();
  } else {
    const response = await fetch({ web: 'http://127.0.0.1:3000/health', api: 'http://127.0.0.1:4000/health', control: 'http://127.0.0.1:3001/admin/health' }[role], { redirect: 'error', signal: AbortSignal.timeout(4000) });
    const health = await response.json();
    if (!response.ok || health.release?.sha !== image.sha || health.release?.version !== image.version) throw new Error();
  }
} catch { console.error('APPLICATION_LIVENESS_OR_RELEASE_CHECK_FAILED'); process.exit(1); }

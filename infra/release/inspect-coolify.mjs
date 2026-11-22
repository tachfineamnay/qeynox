// Explicitly GET-only, scoped inventory. Never outputs env values, tokens, URLs or raw API bodies.
const keys = ['QEYNOX_COOLIFY_BASE_URL', 'QEYNOX_COOLIFY_API_TOKEN', 'QEYNOX_COOLIFY_PROJECT_UUID', 'QEYNOX_COOLIFY_ENVIRONMENT'];
const missing = keys.filter(key => !process.env[key]?.trim());
if (missing.length) { console.log(JSON.stringify({ status: 'BLOCKED', readOnly: true, missing })); process.exit(3); }
try {
  const url = new URL(process.env.QEYNOX_COOLIFY_BASE_URL);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error();
  const project = process.env.QEYNOX_COOLIFY_PROJECT_UUID, environment = process.env.QEYNOX_COOLIFY_ENVIRONMENT;
  if (![project, environment].every(value => /^[A-Za-z0-9_-]+$/.test(value))) throw new Error();
  const response = await fetch(new URL('/api/v1/projects/' + encodeURIComponent(project) + '/' + encodeURIComponent(environment), url), {
    method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10_000),
    headers: { authorization: 'Bearer ' + process.env.QEYNOX_COOLIFY_API_TOKEN, accept: 'application/json' },
  });
  if (!response.ok) throw new Error();
  const data = await response.json();
  if ((data.name !== environment && data.uuid !== environment) || !Array.isArray(data.applications) || !Array.isArray(data.services)) throw new Error();
  const resources = ['applications', 'services', 'databases', 'postgresqls', 'redis'].flatMap(type => (Array.isArray(data[type]) ? data[type] : []).flatMap(value => {
    if (typeof value?.uuid !== 'string' || typeof value?.name !== 'string') return [];
    return [{ type, uuid: value.uuid, name: value.name, status: typeof value.status === 'string' ? value.status : 'unknown',
      selectedSha: typeof value.git_commit_sha === 'string' && /^[a-f0-9]{40}$/.test(value.git_commit_sha) ? value.git_commit_sha : null }];
  }));
  console.log(JSON.stringify({ status: 'INSPECTED', readOnly: true, inspectedAt: new Date().toISOString(), scope: { project, environment }, resources, boundary: 'Selected SHA is not proof of the running image; separately verify Docker image labels and health release metadata. Native DBs may require separate read-only UI inventory on this Coolify version.' }, null, 2));
} catch { console.error(JSON.stringify({ status: 'BLOCKED', readOnly: true, code: 'COOLIFY_INSPECTION_FAILED_OR_UNSUPPORTED_SCHEMA' })); process.exitCode = 3; }

// Deployment-only contract. Diagnostics contain key names/codes, never values or credentials.
export const roles = ['web', 'api', 'worker', 'control'];
export const common = ['NODE_ENV', 'QEYNOX_DEPLOYMENT_ENV', 'QEYNOX_RELEASE_SHA', 'QEYNOX_RELEASE_VERSION', 'QEYNOX_COMMERCE_MODE', 'QEYNOX_REGISTRATION_MODE'];
export const backend = ['DATABASE_URL', 'QEYNOX_REDIS_URL', 'HATCHET_CLIENT_TOKEN', 'HATCHET_CLIENT_API_URL', 'HATCHET_CLIENT_HOST_PORT', 'HATCHET_CLIENT_TLS_STRATEGY', 'HERMES_API_BASE_URL', 'HERMES_PRIVATE_ORIGIN', 'HERMES_API_KEY', 'HERMES_MODEL', 'QEYNOX_ARTIFACT_ENDPOINT', 'QEYNOX_ARTIFACT_BUCKET', 'QEYNOX_ARTIFACT_REGION', 'QEYNOX_ARTIFACT_ACCESS_KEY', 'QEYNOX_ARTIFACT_SECRET_KEY', 'QEYNOX_SERVICE_CATALOG_PATH'];
export const required = {
  web: [...common, 'QEYNOX_API_URL', 'QEYNOX_API_PRIVATE_ORIGIN', 'QEYNOX_PUBLIC_URL', 'QEYNOX_STORAGE_RELAY_KEY', 'QEYNOX_ARTIFACT_ENDPOINT', 'QEYNOX_ARTIFACT_BUCKET'],
  control: [...common, 'QEYNOX_PLATFORM_API_URL', 'QEYNOX_PLATFORM_API_PRIVATE_ORIGIN', 'QEYNOX_PUBLIC_URL'],
  api: [...common, ...backend, 'QEYNOX_PUBLIC_URL', 'QEYNOX_EMAIL_PROVIDER', 'QEYNOX_RESEND_API_KEY', 'QEYNOX_EMAIL_FROM', 'QEYNOX_OPERATOR_USER_IDS'],
  worker: [...common, ...backend, 'QEYNOX_PUBLIC_URL', 'QEYNOX_EMAIL_PROVIDER', 'QEYNOX_RESEND_API_KEY', 'QEYNOX_EMAIL_FROM'],
};
export const optional = {
  backend: ['HATCHET_CLIENT_TLS_CERT_FILE', 'HATCHET_CLIENT_TLS_KEY_FILE', 'HATCHET_CLIENT_TLS_ROOT_CA_FILE', 'HATCHET_CLIENT_TLS_SERVER_NAME', 'HERMES_PROVIDER', 'HERMES_REQUEST_TIMEOUT_MS', 'HERMES_NATIVE_TOOLS_ISOLATED', 'QEYNOX_NETWORK_POLICY_ATTESTED', 'QEYNOX_RUNTIME_PROBE_TIMEOUT_MS', 'QEYNOX_RUNTIME_PROBE_FRESHNESS_SECONDS', 'QEYNOX_RUNTIME_PROBE_INTERVAL_SECONDS', 'QEYNOX_DOCUMENT_INGEST_INTERVAL_MS', 'QEYNOX_DOCUMENT_INGEST_LEASE_MS', 'QEYNOX_ARTIFACT_SERVER_SIDE_ENCRYPTION', 'QEYNOX_WORLD_BANK_ENABLED', 'QEYNOX_BRAVE_SEARCH_ENABLED', 'QEYNOX_BRAVE_SEARCH_API_KEY', 'QEYNOX_EGRESS_ALLOWED_HOSTS', 'QEYNOX_EMBEDDINGS_ENABLED', 'QEYNOX_EMBEDDINGS_ENDPOINT', 'QEYNOX_EMBEDDINGS_MODEL', 'QEYNOX_EMBEDDINGS_API_KEY', 'QEYNOX_EMBEDDINGS_ALLOWED_HOSTS'],
  api: ['QEYNOX_CONNECTION_CREDENTIAL_KEY', 'QEYNOX_GOOGLE_WORKSPACE_CLIENT_ID', 'QEYNOX_GOOGLE_WORKSPACE_CLIENT_SECRET', 'QEYNOX_GOOGLE_WORKSPACE_REDIRECT_URI', 'QEYNOX_COOLIFY_BASE_URL', 'QEYNOX_COOLIFY_API_TOKEN', 'QEYNOX_COOLIFY_PROJECT_UUID', 'QEYNOX_COOLIFY_ENVIRONMENT'],
  web: ['QEYNOX_CONTACT_EMAIL'], control: [],
};
export function diagnostics(role, env, image) {
  const issues = [];
  const fail = (key, code) => issues.push({ key, code });
  if (!roles.includes(role)) return [{ key: 'role', code: 'UNKNOWN_ROLE' }];
  for (const key of required[role]) if (!env[key]?.trim()) fail(key, 'REQUIRED');
  for (const [key, value] of Object.entries({ NODE_ENV: 'production', QEYNOX_COMMERCE_MODE: 'BETA_FREE', QEYNOX_REGISTRATION_MODE: 'INVITE_ONLY' })) {
    if (env[key] !== value) fail(key, 'REQUIRED_POLICY');
  }
  if (!['preproduction', 'production'].includes(env.QEYNOX_DEPLOYMENT_ENV)) fail('QEYNOX_DEPLOYMENT_ENV', 'INVALID_ENVIRONMENT');
  if (!/^[a-f0-9]{40}$/.test(env.QEYNOX_RELEASE_SHA ?? '')) fail('QEYNOX_RELEASE_SHA', 'FULL_SHA_REQUIRED');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(env.QEYNOX_RELEASE_VERSION ?? '')) fail('QEYNOX_RELEASE_VERSION', 'INVALID_VERSION');
  if (image && (image.sha !== env.QEYNOX_RELEASE_SHA || image.version !== env.QEYNOX_RELEASE_VERSION)) fail('QEYNOX_RELEASE_SHA', 'IMAGE_ENV_SKEW');
  for (const key of ['QEYNOX_ALLOW_MIGRATIONS', 'QEYNOX_ALLOW_DATABASE_UPGRADE', 'QEYNOX_ALLOW_PREPRODUCTION_MIGRATIONS', 'QEYNOX_PLATFORM_BOOTSTRAP_ALLOW', 'QEYNOX_QA_ALLOW_UNVERIFIED', 'QEYNOX_ALLOW_REGISTRATION']) {
    if (env[key] && env[key] !== 'false') fail(key, 'FORBIDDEN_RUNTIME_OVERRIDE');
  }
  for (const key of Object.keys(env)) if (/STRIPE.*(SECRET|KEY)|^NEXT_PUBLIC_.*(SECRET|TOKEN|KEY|DATABASE|REDIS|HERMES)/i.test(key) && env[key]) fail(key, 'FORBIDDEN_CREDENTIAL');
  const privateUrl = (key, hosts, protocols, port, path = '/') => {
    if (!env[key]) return;
    try {
      const url = new URL(env[key]);
      if (!hosts.includes(url.hostname) || !protocols.includes(url.protocol) || (port && (url.port || ({ 'https:': '443', 'http:': '80', 'redis:': '6379', 'rediss:': '6379' }[url.protocol])) !== port) || url.pathname !== path || url.search || url.hash) throw new Error();
      if (!['DATABASE_URL', 'QEYNOX_REDIS_URL'].includes(key) && (url.username || url.password)) throw new Error();
    } catch { fail(key, 'PRIVATE_ENDPOINT_REQUIRED'); }
  };
  if (['web', 'control'].includes(role)) {
    const key = role === 'web' ? 'QEYNOX_API_URL' : 'QEYNOX_PLATFORM_API_URL';
    const authorization = role === 'web' ? 'QEYNOX_API_PRIVATE_ORIGIN' : 'QEYNOX_PLATFORM_API_PRIVATE_ORIGIN';
    privateUrl(key, ['qeynox-api'], ['http:'], '4000');
    if (env[key] !== env[authorization]) fail(authorization, 'EXACT_PRIVATE_ORIGIN_REQUIRED');
  }
  if (role === 'api' && env.PORT && env.PORT !== '4000') fail('PORT', 'PRIVATE_API_PORT_REQUIRED');
  if (env.QEYNOX_BOOTSTRAP_PASSWORD) fail('QEYNOX_BOOTSTRAP_PASSWORD', 'FORBIDDEN_RUNTIME_OVERRIDE');
  if (env.QEYNOX_PUBLIC_URL) {
    try { const url = new URL(env.QEYNOX_PUBLIC_URL); if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error(); }
    catch { fail('QEYNOX_PUBLIC_URL', 'HTTPS_ORIGIN_REQUIRED'); }
  }
  if (role === 'web' && !/^[A-Za-z0-9+/]{43}=$/.test(env.QEYNOX_STORAGE_RELAY_KEY ?? '')) fail('QEYNOX_STORAGE_RELAY_KEY', 'BASE64_32_BYTES_REQUIRED');
  if (['api', 'worker'].includes(role)) {
    if (!['none', 'tls'].includes(env.HATCHET_CLIENT_TLS_STRATEGY)) fail('HATCHET_CLIENT_TLS_STRATEGY', 'INVALID_TLS_STRATEGY');
    if (env.QEYNOX_DEPLOYMENT_ENV === 'production' && env.HATCHET_CLIENT_TLS_STRATEGY === 'none') fail('HATCHET_CLIENT_TLS_STRATEGY', 'PRODUCTION_TLS_REQUIRED');
    privateUrl('HERMES_API_BASE_URL', ['qeynox-hermes'], ['http:'], '8642', '/v1/');
    if (env.HERMES_PRIVATE_ORIGIN !== 'http://qeynox-hermes:8642') fail('HERMES_PRIVATE_ORIGIN', 'EXACT_PRIVATE_ORIGIN_REQUIRED');
    privateUrl('HATCHET_CLIENT_API_URL', ['qeynox-hatchet'], ['http:'], '8888');
    if (env.HATCHET_CLIENT_HOST_PORT !== 'qeynox-hatchet:7077') fail('HATCHET_CLIENT_HOST_PORT', 'PRIVATE_ENDPOINT_REQUIRED');
    // Native Coolify database aliases from the recorded inventory; never public DNS.
    if (env.DATABASE_URL) {
      try { const url = new URL(env.DATABASE_URL); if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['qeynox-postgres', 'cris5cemg9ja3g3ur5tyiypg'].includes(url.hostname) || (url.port && url.port !== '5432') || !url.username || !url.password || url.pathname.length < 2 || url.search || url.hash) throw new Error(); }
      catch { fail('DATABASE_URL', 'PRIVATE_DATABASE_REQUIRED'); }
    }
    privateUrl('QEYNOX_REDIS_URL', ['qeynox-redis', 'lnclv7rbyekp5ks5iokxbxvj'], ['redis:', 'rediss:'], '6379', '/0');
    if (env.QEYNOX_REDIS_URL) { try { if (!new URL(env.QEYNOX_REDIS_URL).password) fail('QEYNOX_REDIS_URL', 'PASSWORD_REQUIRED'); } catch { /* diagnosed above */ } }
    if (env.QEYNOX_EMAIL_PROVIDER !== 'resend') fail('QEYNOX_EMAIL_PROVIDER', 'INVITATION_TRANSPORT_REQUIRED');
    if (env.QEYNOX_ARTIFACT_SERVER_SIDE_ENCRYPTION !== 'AES256') fail('QEYNOX_ARTIFACT_SERVER_SIDE_ENCRYPTION', 'ENCRYPTION_REQUIRED');
  }
  if (['api', 'worker', 'web'].includes(role)) privateUrl('QEYNOX_ARTIFACT_ENDPOINT', ['qeynox-storage'], ['http:'], '9000');
  const conditional = (enabled, keys) => { if (enabled) for (const key of keys) if (!env[key]?.trim()) fail(key, 'REQUIRED_FOR_ENABLED_FEATURE'); };
  conditional(['api', 'worker'].includes(role) && env.QEYNOX_BRAVE_SEARCH_ENABLED === 'true', ['QEYNOX_BRAVE_SEARCH_API_KEY', 'QEYNOX_EGRESS_ALLOWED_HOSTS']);
  conditional(['api', 'worker'].includes(role) && env.QEYNOX_EMBEDDINGS_ENABLED === 'true', ['QEYNOX_EMBEDDINGS_ENDPOINT', 'QEYNOX_EMBEDDINGS_API_KEY', 'QEYNOX_EMBEDDINGS_MODEL', 'QEYNOX_EMBEDDINGS_ALLOWED_HOSTS']);
  const oauth = ['QEYNOX_GOOGLE_WORKSPACE_CLIENT_ID', 'QEYNOX_GOOGLE_WORKSPACE_CLIENT_SECRET', 'QEYNOX_GOOGLE_WORKSPACE_REDIRECT_URI'];
  conditional(role === 'api' && oauth.some(key => env[key]), [...oauth, 'QEYNOX_CONNECTION_CREDENTIAL_KEY']);
  const inventory = ['QEYNOX_COOLIFY_BASE_URL', 'QEYNOX_COOLIFY_API_TOKEN', 'QEYNOX_COOLIFY_PROJECT_UUID', 'QEYNOX_COOLIFY_ENVIRONMENT'];
  conditional(role === 'api' && inventory.some(key => env[key]), inventory);
  if (env.QEYNOX_CONNECTION_CREDENTIAL_KEY && !/^[A-Za-z0-9+/]{43}=$/.test(env.QEYNOX_CONNECTION_CREDENTIAL_KEY)) fail('QEYNOX_CONNECTION_CREDENTIAL_KEY', 'BASE64_32_BYTES_REQUIRED');
  if (env.QEYNOX_RUNTIME_PROBES === 'off') fail('QEYNOX_RUNTIME_PROBES', 'FORBIDDEN_RUNTIME_OVERRIDE');
  for (const key of ['HERMES_NATIVE_TOOLS_ISOLATED', 'QEYNOX_NETWORK_POLICY_ATTESTED', 'QEYNOX_WORLD_BANK_ENABLED', 'QEYNOX_BRAVE_SEARCH_ENABLED', 'QEYNOX_EMBEDDINGS_ENABLED']) {
    if (env[key] && !['true', 'false'].includes(env[key])) fail(key, 'BOOLEAN_REQUIRED');
  }
  return issues;
}

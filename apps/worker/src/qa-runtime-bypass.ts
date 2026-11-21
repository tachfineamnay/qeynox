/**
 * MISSION P08 — the worker's QA runtime bypass is honoured ONLY inside an explicitly isolated QA run.
 *
 * `QEYNOX_QA_ALLOW_UNVERIFIED=true` lets isolated QA suites drive a deterministic local Hermes double
 * without the A21.07 live-probe gate. Previously it worked whenever NODE_ENV was not `production`, so a
 * staging/preproduction worker (or any deployment that forgot NODE_ENV) could execute tenant steps on
 * an unverified runtime. Now EVERY condition below must hold, otherwise the bypass is refused and the
 * normal fail-closed gate applies:
 *
 * 1. Explicit marker: `QEYNOX_QA_ENVIRONMENT=isolated` (set only by QA scripts, never by infra).
 * 2. Not a deployment: NODE_ENV unset, `test` or `development`; QEYNOX_DEPLOYMENT_ENV unset.
 * 3. Disposable database: the URL the worker ACTUALLY connected with is PostgreSQL on a loopback host
 *    and names a `qeynox_qa_*` database (the pattern created by `createIsolatedQaDatabase`), and the QA
 *    admin URL `QEYNOX_QA_DATABASE_URL` is present and loopback too.
 * 4. Disposable runtime: Hermes, if configured, is a loopback endpoint (a local double), and no Hatchet
 *    client token is configured (the worker is not wired to a real orchestrator).
 *
 * The check is pure (env + connected URLs in, decision out) and reports reasons by NAME only, never a
 * value, so it can be logged without leaking credentials.
 */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const QA_DATABASE_NAME = /^qeynox_qa_[a-z0-9_]{6,40}$/;
const QA_NODE_ENVS = new Set(['', 'test', 'development']);

export interface QaRuntimeBypassDecision {
  /** True only when the bypass was requested AND every isolation condition holds. */
  readonly allowed: boolean;
  /** True when `QEYNOX_QA_ALLOW_UNVERIFIED=true` was set. */
  readonly requested: boolean;
  /** Names of the unmet conditions (no values). Empty when allowed or not requested. */
  readonly refusedBecause: readonly string[];
}

function parse(url: string | undefined): URL | null {
  if (!url || !url.trim()) return null;
  try { return new URL(url.trim()); } catch { return null; }
}

function isLoopback(url: URL | null): boolean {
  return url !== null && LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
}

function isDisposableQaDatabase(url: URL | null): boolean {
  if (!url || (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:')) return false;
  if (!isLoopback(url)) return false;
  return QA_DATABASE_NAME.test(decodeURIComponent(url.pathname.replace(/^\/+/, '')));
}

export function evaluateQaRuntimeBypass(
  env: NodeJS.ProcessEnv,
  connected: { readonly databaseUrl: string | undefined; readonly hermesBaseUrl: string | undefined },
): QaRuntimeBypassDecision {
  const requested = env.QEYNOX_QA_ALLOW_UNVERIFIED === 'true';
  if (!requested) return { allowed: false, requested, refusedBecause: [] };
  const refused: string[] = [];
  if (env.QEYNOX_QA_ENVIRONMENT !== 'isolated') refused.push('QEYNOX_QA_ENVIRONMENT=isolated is not set');
  if (!QA_NODE_ENVS.has((env.NODE_ENV ?? '').trim())) refused.push('NODE_ENV is not unset/test/development');
  if ((env.QEYNOX_DEPLOYMENT_ENV ?? '').trim()) refused.push('QEYNOX_DEPLOYMENT_ENV is set (deployed environment)');
  if (!isDisposableQaDatabase(parse(connected.databaseUrl))) refused.push('DATABASE_URL is not a loopback qeynox_qa_* database');
  if (!isLoopback(parse(env.QEYNOX_QA_DATABASE_URL))) refused.push('QEYNOX_QA_DATABASE_URL is not a loopback QA database');
  for (const [name, value] of [['HERMES_API_BASE_URL (connected)', connected.hermesBaseUrl], ['HERMES_API_BASE_URL', env.HERMES_API_BASE_URL]] as const) {
    if (value && value.trim() && !isLoopback(parse(value))) refused.push(name + ' is not a loopback QA double');
  }
  if ((env.HATCHET_CLIENT_TOKEN ?? '').trim()) refused.push('HATCHET_CLIENT_TOKEN is configured (real orchestrator)');
  return { allowed: refused.length === 0, requested, refusedBecause: refused };
}

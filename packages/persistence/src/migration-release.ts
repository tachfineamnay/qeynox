import { DomainError } from '@qeynox/domain';
import { inspectMigrations, runMigrations, type MigrationInspection } from './migrate';

export interface ReleaseOptions {
  readonly mode: 'preflight' | 'dry-run' | 'apply';
  readonly target: { readonly host: string; readonly port: number; readonly database: string; readonly user: string };
  readonly planSha256?: string;
  readonly backupReference?: string;
  readonly backupSha256?: string;
  readonly backupRestoreConfirmed: boolean;
  readonly writesStopped: boolean;
}
function invalid(message: string): never { throw new DomainError('INVALID_INPUT', message); }
const sha256 = /^[a-f0-9]{64}$/;

/** Strict parser: a typo must never silently select apply, a target or a confirmation. */
export function parseReleaseOptions(args: readonly string[]): ReleaseOptions {
  const values = new Map<string, string>();
  const flags = new Set(['confirm-backup-restored', 'confirm-writes-stopped']);
  const valued = new Set(['mode', 'target-host', 'target-port', 'target-database', 'target-user', 'plan-sha256', 'backup-reference', 'backup-sha256']);
  for (let i = 0; i < args.length; i++) {
    const key = args[i]?.replace(/^--/, '');
    if (!key || args[i] !== '--' + key || (!flags.has(key) && !valued.has(key)) || values.has(key)) invalid('Unknown or duplicate release option');
    if (flags.has(key)) values.set(key, 'true');
    else {
      const value = args[++i];
      if (!value || value.startsWith('--') || /[\r\n]/.test(value)) invalid('Missing or invalid value for --' + key);
      values.set(key, value);
    }
  }
  const required = (key: string): string => values.get(key)?.trim() || invalid('Explicit --' + key + ' required');
  const mode = values.get('mode') ?? 'preflight';
  if (mode !== 'preflight' && mode !== 'dry-run' && mode !== 'apply') invalid('Mode must be preflight, dry-run or apply');
  const portText = required('target-port');
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || !Number.isInteger(port) || port < 1 || port > 65535) invalid('Invalid target port');
  const result: ReleaseOptions = {
    mode, target: { host: required('target-host'), port, database: required('target-database'), user: required('target-user') },
    planSha256: values.get('plan-sha256'), backupReference: values.get('backup-reference'), backupSha256: values.get('backup-sha256'),
    backupRestoreConfirmed: values.has('confirm-backup-restored'), writesStopped: values.has('confirm-writes-stopped'),
  };
  if (mode === 'apply') {
    if (!result.planSha256 || !sha256.test(result.planSha256)) invalid('Apply requires --plan-sha256 from a reviewed preflight');
    if (!result.backupReference?.trim() || !result.backupSha256 || !sha256.test(result.backupSha256) || !result.backupRestoreConfirmed) invalid('Apply requires backup reference, SHA-256 and explicit restore-test confirmation');
    if (!result.writesStopped) invalid('Apply requires --confirm-writes-stopped');
  }
  return result;
}

/** Compare to the actual connection parameters; never log the connection URL/password. */
export function assertReleaseConnection(raw: string | undefined, options: ReleaseOptions): string {
  if (!raw) invalid('DATABASE_URL required');
  let url: URL;
  try { url = new URL(raw); } catch { return invalid('Invalid PostgreSQL connection URL'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || url.hash) invalid('A TCP PostgreSQL URL is required');
  for (const key of url.searchParams.keys()) {
    if (!['sslmode', 'sslrootcert', 'sslcert', 'sslkey'].includes(key)) invalid('Connection parameter overrides are forbidden');
  }
  if (url.hostname !== options.target.host || Number(url.port || 5432) !== options.target.port ||
      decodeURIComponent(url.pathname.slice(1)) !== options.target.database || decodeURIComponent(url.username) !== options.target.user) {
    invalid('Explicit target identity does not match DATABASE_URL');
  }
  return raw;
}

export function assertReleaseInspection(inspection: MigrationInspection, options: ReleaseOptions): void {
  if (inspection.target.database !== options.target.database || inspection.target.user !== options.target.user || !inspection.target.serverAddress || !inspection.target.serverPort) {
    throw new DomainError('DENIED', 'Observed database identity does not match the explicit TCP target');
  }
  if (options.mode === 'apply' && inspection.planSha256 !== options.planSha256) {
    throw new DomainError('CONFLICT', 'Release plan changed; inspect again and explicitly approve the new plan before resuming');
  }
}

/** Operator-only composition of the existing engine; never imported by application startup. */
export async function executeDatabaseRelease(args: readonly string[], env: NodeJS.ProcessEnv, output: (value: unknown) => void): Promise<void> {
  const options = parseReleaseOptions(args);
  const connection = assertReleaseConnection(env.DATABASE_URL, options);
  if (options.mode === 'apply' && env.QEYNOX_ALLOW_DATABASE_UPGRADE !== 'true') {
    throw new DomainError('DENIED', 'Apply requires QEYNOX_ALLOW_DATABASE_UPGRADE=true');
  }
  const reportInspection = (inspection: MigrationInspection) => {
    assertReleaseInspection(inspection, options);
    output({ mode: options.mode, requestedTarget: options.target, ...inspection,
      ...(options.mode === 'apply' ? { authorization: { backupReference: options.backupReference, backupSha256: options.backupSha256, backupRestoreConfirmed: options.backupRestoreConfirmed, writesStopped: options.writesStopped } } : {}),
    });
  };
  if (options.mode !== 'apply') {
    const inspection = await inspectMigrations(connection, { tryLock: true, statementTimeoutMs: 30_000 });
    reportInspection(inspection);
    if (inspection.blockers.length) throw new DomainError('CONFLICT', 'Preflight blocked; see inspection report');
    return;
  }
  const report = await runMigrations(connection, {
    tryLock: true,
    beforeApply: reportInspection,
    onProgress: (event, name) => output({ event, name }),
  });
  output({ mode: 'apply', backupReference: options.backupReference, backupSha256: options.backupSha256, backupRestoreConfirmed: true, ...report });
}

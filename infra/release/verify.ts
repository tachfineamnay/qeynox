/** Explicit read-only release verification. Never imported by app startup; never migrates. */
import { loadMigrations, inspectMigrations } from '../../packages/persistence/src/migrate';
import { createRuntimeProbeMonitor, runtimeExecutionBlocker } from '../../packages/application/src/index';
import { diagnostics, roles } from './contract.mjs';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--live') || args.length > 1) throw new Error('Usage: pnpm release:verify [--live]');
  const issues = roles.flatMap(role => diagnostics(role, process.env).map(issue => ({ role, ...issue })));
  const migrations = await loadMigrations();
  if (issues.length) { console.log(JSON.stringify({ status: 'BLOCKED', discoveredMigrations: migrations.length, issues })); process.exitCode = 1; return; }
  if (!args.includes('--live')) {
    console.log(JSON.stringify({ status: 'CONFIGURED_NOT_VERIFIED', discoveredMigrations: migrations.length, boundary: 'No network or DB inspection. --live explicitly opts into bounded read-only probes.' }));
    return;
  }
  const inspection = await inspectMigrations(process.env.DATABASE_URL, { tryLock: true, statementTimeoutMs: 30_000 });
  const checks: { component: string; ok: boolean }[] = [
    { component: 'migration-history', ok: inspection.blockers.length === 0 && inspection.pending.length === 0 && inspection.applied.length === migrations.length },
  ];
  for (const [role, url] of [['api', 'http://qeynox-api:4000/health'], ['web', 'http://qeynox-web:3000/health'], ['control', 'http://qeynox-control:3001/admin/health']]) {
    let ok = false;
    try {
      const response = await fetch(url!, { redirect: 'error', signal: AbortSignal.timeout(5000) });
      const body = await response.json() as { release?: { sha?: string; version?: string } };
      ok = response.ok && body.release?.sha === process.env.QEYNOX_RELEASE_SHA && body.release?.version === process.env.QEYNOX_RELEASE_VERSION;
    } catch { /* report component failure, never raw errors or URLs */ }
    checks.push({ component: role!, ok });
  }
  const monitor = createRuntimeProbeMonitor(process.env);
  try { checks.push({ component: 'hermes-hatchet-runtime', ok: !runtimeExecutionBlocker(await monitor.freshReadiness()) }); }
  finally { monitor.stop(); }
  console.log(JSON.stringify({ status: checks.every(check => check.ok) ? 'AUTOMATED_CHECKS_PASSED_MANUAL_GATES_REMAIN' : 'BLOCKED', checks,
    migrations: { discovered: migrations.length, applied: inspection.applied.length, pending: inspection.pending.length, mismatches: inspection.mismatches.length },
    manualGates: ['Current Coolify scope/resources and running immutable image labels including Worker', 'Authenticated Redis PING, private S3 operations, volume/KMS/backup retention', 'Worker live shutdown/leases/recovery and isolated populated DB migration rehearsal', 'Actual Hermes native-tool confinement and egress firewall', 'Backup/rollback authorization and preserved financial history'],
  }));
  process.exitCode = checks.every(check => check.ok) ? 0 : 1;
}
main().catch(() => { console.error('RELEASE_VERIFICATION_FAILED: inspect secured service logs; no deploy/restart/migration was attempted'); process.exitCode = 1; });

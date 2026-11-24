/**
 * Self-test for the real object-storage QA procedure (`qa-object-storage.ts`, `pnpm qa:storage`).
 *
 * It proves the EXIT-CODE CONTRACT of the storage QA by spawning it as a subprocess:
 *   0  PASS     every assertion completed against an operator-supplied isolated S3 + database
 *   3  BLOCKED  a required prerequisite (QEYNOX_QA_S3_* or QEYNOX_QA_DATABASE_URL) is absent —
 *               the run prints BLOCKED, emits no evidence line and must never count as a pass
 *   1  FAILED   a real assertion failure — never silently reclassified as blocked or passed
 *
 * The PASS leg runs only when this self-test itself is given real isolated QA prerequisites
 * (QEYNOX_QA_S3_* + QEYNOX_QA_DATABASE_URL, e.g. a disposable MinIO and PostgreSQL); without
 * them that leg is reported NOT RUN and no storage claim is made. The deliberate-failure leg
 * uses the documented test-only fault hook QEYNOX_QA_STORAGE_SELFTEST_FAULT=assertion, which
 * can only fail a run earlier — it can never bypass or soften a real assertion.
 *
 * This validates the harness outcomes only. It is NOT object-storage evidence: real storage
 * verification is only ever `pnpm qa:storage` against a real isolated MinIO/S3-compatible
 * service and a disposable PostgreSQL database.
 *
 * Run: pnpm qa:storage-selftest
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

let assertions = 0;
function check(condition: unknown, message: string): asserts condition {
  assertions++;
  if (!condition) throw new Error('ASSERTION FAILED: ' + message);
}

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

async function runStorage(env: Record<string, string>): Promise<{ code: number | null; output: string }> {
  const child = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'apps/worker/scripts/qa-object-storage.ts'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      QEYNOX_QA_S3_ENDPOINT: '', QEYNOX_QA_S3_ACCESS_KEY: '', QEYNOX_QA_S3_SECRET_KEY: '',
      QEYNOX_QA_DATABASE_URL: '', QEYNOX_QA_STORAGE_SELFTEST_FAULT: '',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += String(chunk); });
  child.stderr.on('data', chunk => { output += String(chunk); });
  const [code] = await once(child, 'exit') as [number | null];
  return { code, output };
}

// Placeholder values that satisfy the prerequisite presence checks; they are never contacted
// because the targeted guard (or, in the failure leg, the fault hook) exits before any request.
const dummyS3 = {
  QEYNOX_QA_S3_ENDPOINT: 'http://127.0.0.1:9',
  QEYNOX_QA_S3_ACCESS_KEY: 'qa-storage-selftest',
  QEYNOX_QA_S3_SECRET_KEY: 'qa-storage-selftest',
};

// 1. Missing S3 prerequisites -> BLOCKED (exit 3), never a pass, never evidence.
const missing = await runStorage({});
check(missing.code === 3, 'missing S3 prerequisites exit BLOCKED (3), got ' + missing.code);
check(/STORAGE QA BLOCKED/.test(missing.output), 'blocked run says STORAGE QA BLOCKED');
check(/QEYNOX_QA_S3_ENDPOINT/.test(missing.output), 'blocked run names the missing prerequisite');
check(!/^OBJECT_STORAGE_EVIDENCE/m.test(missing.output), 'blocked run never emits a storage evidence line');
check(!/Object storage QA PASSED/.test(missing.output), 'blocked run never reports PASSED');

// 2. S3 variables present but the isolated QA database URL absent -> still BLOCKED (exit 3).
const noDatabase = await runStorage({ ...dummyS3 });
check(noDatabase.code === 3, 'missing isolated-database prerequisite exits BLOCKED (3), got ' + noDatabase.code);
check(/STORAGE QA BLOCKED/.test(noDatabase.output) && /QEYNOX_QA_DATABASE_URL/.test(noDatabase.output),
  'blocked run names QEYNOX_QA_DATABASE_URL as the missing prerequisite');
check(!/^OBJECT_STORAGE_EVIDENCE/m.test(noDatabase.output), 'database-blocked run never emits a storage evidence line');
check(!/Object storage QA PASSED/.test(noDatabase.output), 'database-blocked run never reports PASSED');

// 3. Deliberate assertion failure -> FAILED (exit 1), never blocked, never passed.
const failed = await runStorage({
  ...dummyS3,
  QEYNOX_QA_DATABASE_URL: 'postgresql://qeynox-selftest:invalid@127.0.0.1:1/qeynox_selftest_absent',
  QEYNOX_QA_STORAGE_SELFTEST_FAULT: 'assertion',
});
check(failed.code === 1, 'deliberate assertion failure exits FAILED (1), got ' + failed.code);
check(/ASSERTION FAILED: deliberate self-test assertion failure/.test(failed.output),
  'the deliberate failure is reported as a real assertion failure');
check(!/STORAGE QA BLOCKED/.test(failed.output), 'a failing run is never reclassified as BLOCKED');
check(!/^OBJECT_STORAGE_EVIDENCE/m.test(failed.output), 'failing run never emits a storage evidence line');
check(!/Object storage QA PASSED/.test(failed.output), 'failing run never reports PASSED');

// 4. Real isolated S3 + database, operator-supplied -> the only leg allowed to report PASS.
const operatorS3 = process.env.QEYNOX_QA_S3_ENDPOINT && process.env.QEYNOX_QA_S3_ACCESS_KEY && process.env.QEYNOX_QA_S3_SECRET_KEY;
if (operatorS3 && process.env.QEYNOX_QA_DATABASE_URL) {
  const real = await runStorage({
    QEYNOX_QA_S3_ENDPOINT: process.env.QEYNOX_QA_S3_ENDPOINT!,
    QEYNOX_QA_S3_ACCESS_KEY: process.env.QEYNOX_QA_S3_ACCESS_KEY!,
    QEYNOX_QA_S3_SECRET_KEY: process.env.QEYNOX_QA_S3_SECRET_KEY!,
    QEYNOX_QA_DATABASE_URL: process.env.QEYNOX_QA_DATABASE_URL!,
  });
  check(real.code === 0, 'a fully executed storage run exits PASS (0), got ' + real.code);
  check(/Object storage QA PASSED: \d+ assertions/.test(real.output), 'completed run reports its assertion count');
  check(/^OBJECT_STORAGE_EVIDENCE/m.test(real.output), 'completed run emits its storage evidence line');
} else {
  console.log('NOT RUN: the real-S3 PASS leg needs operator-supplied QEYNOX_QA_S3_* and QEYNOX_QA_DATABASE_URL '
    + '(disposable MinIO + PostgreSQL). Nothing was faked and no storage claim is made.');
}

console.log('PASS: storage-QA exit-contract self-test — ' + assertions + ' assertions.');
console.log('This validates the harness outcomes only. It is NOT object-storage evidence; '
  + 'real verification is qa:storage against a real isolated MinIO/S3 and a disposable database.');

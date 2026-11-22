import { DomainError } from '@qeynox/domain';
import { executeDatabaseRelease } from '../src/migration-release';

/** Compatibility entrypoint; no longer an empty-database bypass of release safeguards. */
async function main(): Promise<void> {
  if (process.env.QEYNOX_DEPLOYMENT_ENV !== 'preproduction') {
    throw new DomainError('DENIED', 'This entrypoint requires QEYNOX_DEPLOYMENT_ENV=preproduction; use db:release for other operator targets');
  }
  await executeDatabaseRelease(process.argv.slice(2), process.env, value => console.log(JSON.stringify(value)));
}
main().catch((error: unknown) => {
  console.error(error instanceof DomainError ? error.message : 'Database release failed; inspect secured PostgreSQL logs. No automatic retry.');
  process.exitCode = 1;
});

import { DomainError } from '@qeynox/domain';
import { executeDatabaseRelease } from '../src/migration-release';

executeDatabaseRelease(process.argv.slice(2), process.env, value => console.log(JSON.stringify(value))).catch((error: unknown) => {
  // Do not print pg connection errors/URLs, credentials or arbitrary server detail.
  console.error(error instanceof DomainError ? error.message : 'Database release failed; inspect the secured PostgreSQL logs. No automatic retry.');
  process.exitCode = 1;
});

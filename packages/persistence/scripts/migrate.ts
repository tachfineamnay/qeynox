import { runMigrations } from '../src/migrate';

async function main(): Promise<void> {
  if (process.env.QEYNOX_ALLOW_MIGRATIONS !== 'true') {
    console.error('Refusing to migrate: set QEYNOX_ALLOW_MIGRATIONS=true only for an isolated QA database.');
    process.exitCode = 1;
    return;
  }
  if (process.env.NODE_ENV === 'production') {
    console.error('Refusing to migrate: NODE_ENV=production is not an allowed migration target.');
    process.exitCode = 1;
    return;
  }
  const report = await runMigrations(process.env.DATABASE_URL, {
    onProgress: (event, name) => console.log(event.padEnd(8), name),
  });
  console.log('migrations: ' + report.total + ' total, ' + report.applied.length + ' applied, ' + report.skipped.length + ' skipped');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'migration failed');
  process.exitCode = 1;
});

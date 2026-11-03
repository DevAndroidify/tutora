import { loadAppConfig } from '../platform/config/app-config';
import { runMigrations } from '../platform/database/migrate';

async function main(): Promise<void> {
  const config = loadAppConfig();
  const target = new URL(config.database.url);
  console.log(`Migrating ${target.host}${target.pathname} ...`);
  await runMigrations(config.database.url);
  console.log('Migrations applied.');
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

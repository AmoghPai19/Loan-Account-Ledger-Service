// Gives each integration test file a freshly migrated test database.
import { createPool } from '../../src/db/pool.js';
import { migrate } from '../../scripts/migrate.js';

export const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5433/ledger_test';

export async function freshDatabase() {
  const admin = createPool(TEST_DB_URL);
  await admin.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await admin.end();
  await migrate(TEST_DB_URL);
  return createPool(TEST_DB_URL);
}
// Run the accrual job once.
//   npm run accrue                      -> as of today (India time)
//   npm run accrue -- --as-of 2026-03-02
import { pathToFileURL } from 'node:url';
import { createPool } from '../src/db/pool.js';
import { runAccruals, systemUserId, todayInIndia } from '../src/jobs/accrual.js';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const i = process.argv.indexOf('--as-of');
  const asOf = i > -1 ? process.argv[i + 1] : todayInIndia();
  const pool = createPool();
  try {
    const totals = await runAccruals(pool, { asOf, actorId: await systemUserId(pool) });
    console.log(JSON.stringify(totals, null, 2));
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
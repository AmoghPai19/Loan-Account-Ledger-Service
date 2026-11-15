// =====================================================================
// server.js: starts the API.   npm start   (PORT defaults to 3000)
//
// Set ACCRUAL_DAILY_AT=HH:MM in .env to also run the accrual job every
// day at that time, India time (Step 8).
// =====================================================================
import { createPool } from './db/pool.js';
import { createApp } from './app.js';
import { startDailyAccruals } from './jobs/scheduler.js';

const pool = createPool();
const port = Number(process.env.PORT ?? 3000);

const server = createApp({ pool }).listen(port, () => {
  console.log(`Loan ledger API listening on http://localhost:${port}`);
});

const scheduler = process.env.ACCRUAL_DAILY_AT
  ? startDailyAccruals(pool, process.env.ACCRUAL_DAILY_AT)
  : null;

// Ctrl+C: stop accepting requests, let running ones finish, close DB connections.
process.on('SIGINT', () => {
  console.log('Shutting down...');
  scheduler?.stop();
  server.close(() => pool.end().then(() => process.exit(0)));
});
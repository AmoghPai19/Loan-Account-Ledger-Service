// =====================================================================
// server.js: starts the API.   npm start   (PORT defaults to 3000)
// =====================================================================
import { createPool } from './db/pool.js';
import { createApp } from './app.js';

const pool = createPool();
const port = Number(process.env.PORT ?? 3000);

const server = createApp({ pool }).listen(port, () => {
  console.log(`Loan ledger API listening on http://localhost:${port}`);
});

// Ctrl+C: stop accepting requests, let running ones finish, close DB connections.
process.on('SIGINT', () => {
  console.log('Shutting down...');
  server.close(() => pool.end().then(() => process.exit(0)));
});
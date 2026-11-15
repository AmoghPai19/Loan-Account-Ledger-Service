import pg from 'pg';

// Load variables from a .env file in the current folder, if there is one
// (Node 20.12+ has this built in). Values already set in the shell win.
try {
  process.loadEnvFile();
} catch {
  // no .env file: fine, fall back to the shell environment
}

// --- Type parsers: two classic Node + Postgres bugs, fixed up front ---------
//
// 1) BIGINT (type OID 20). node-postgres returns BIGINT as a *string* by
//    default, because a JS number can't hold every 64-bit integer. Our amounts
//    are paise, and JS numbers are exact up to 2^53 - 1 paise (about
//    Rs.90 lakh crore), so we convert to number and fail loudly if a value
//    is ever too big to be exact.  (Decision D12)
pg.types.setTypeParser(20, (value) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`BIGINT ${value} exceeds the safe integer range`);
  }
  return n;
});

// 2) DATE (type OID 1082). By default it becomes a JS Date at *local
//    midnight*, which can shift by a day depending on the server's timezone
//    (in IST, 2026-03-03 can come back as 2026-03-02T18:30Z). Due dates must
//    never move, so we keep them as plain 'YYYY-MM-DD' strings.  (Decision D13)
pg.types.setTypeParser(1082, (value) => value);

export function createPool(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  return new pg.Pool({ connectionString, max: 20 });
}
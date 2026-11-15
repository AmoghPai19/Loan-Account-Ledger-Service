// =====================================================================
// tx.js: run several queries as ONE database transaction.
//
// Either every statement inside `fn` is saved (COMMIT), or none of them
// is (ROLLBACK). A repayment writes a ledger header, several entry lines
// and maybe a loan status change; they must succeed or fail together.
// =====================================================================

export async function withTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT'); // the deferred "debits = credits" check (D7) runs here
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // the connection may already be broken; the original error matters more
    }
    throw err;
  } finally {
    client.release(); // always hand the connection back to the pool
  }
}
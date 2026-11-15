// Proves the database itself enforces the ledger rules (D6, D7),
// independent of any application code.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDatabase } from '../helpers/db.js';

describe('database-level ledger rules', () => {
  let pool;
  let systemUser;
  let bank;
  let income;

  before(async () => {
    pool = await freshDatabase();
    systemUser = (await pool.query(`SELECT id FROM users WHERE username = 'system'`)).rows[0].id;
    const accts = await pool.query(`SELECT id, code FROM accounts WHERE loan_id IS NULL`);
    const byCode = Object.fromEntries(accts.rows.map((r) => [r.code, r.id]));
    bank = byCode.BANK;
    income = byCode.INTEREST_INCOME;
  });
  after(() => pool?.end()); // pool is undefined if the DB was unreachable

  /** Insert one transaction with the given lines inside a DB transaction; returns its id. */
  async function post(lines) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const txn = await client.query(
        `INSERT INTO ledger_transactions (type, effective_date, created_by)
         VALUES ('INTEREST_ACCRUAL', '2026-01-01', $1) RETURNING id`, [systemUser]);
      for (const [account, dir, amount] of lines) {
        await client.query(
          `INSERT INTO ledger_entries (transaction_id, account_id, direction, amount_paise)
           VALUES ($1, $2, $3, $4)`, [txn.rows[0].id, account, dir, amount]);
      }
      await client.query('COMMIT');                // the deferred balance check runs here
      return txn.rows[0].id;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  it('seeds the three products and four company accounts', async () => {
    const products = await pool.query('SELECT code FROM loan_products ORDER BY code');
    assert.deepEqual(products.rows.map((r) => r.code), ['EMI', 'FLT', 'WGL']);
    const accounts = await pool.query('SELECT count(*)::int AS n FROM accounts WHERE loan_id IS NULL');
    assert.equal(accounts.rows[0].n, 4);
  });

  it('accepts a balanced transaction', async () => {
    assert.ok(await post([[bank, 'DEBIT', 500], [income, 'CREDIT', 500]]));
  });

  it('rejects an unbalanced transaction at COMMIT (D7)', async () => {
    await assert.rejects(post([[bank, 'DEBIT', 500], [income, 'CREDIT', 499]]), /unbalanced/);
  });

  it('rejects a transaction header with no entries (D7)', async () => {
    await assert.rejects(post([]), /at least 2/);
  });

  it('rejects zero or negative amounts', async () => {
    await assert.rejects(post([[bank, 'DEBIT', 0], [income, 'CREDIT', 0]]));
  });

  it('forbids editing or deleting ledger rows (D6)', async () => {
    await assert.rejects(pool.query('UPDATE ledger_entries SET amount_paise = 1'), /append-only/);
    await assert.rejects(pool.query('DELETE FROM ledger_transactions'), /append-only/);
  });

  it('derives balances from entries via the account_balances view (D6)', async () => {
    const rows = await pool.query(
      `SELECT code, raw_balance_paise, natural_balance_paise
         FROM account_balances WHERE loan_id IS NULL ORDER BY code`);
    const bal = Object.fromEntries(rows.rows.map((r) => [r.code, r]));
    // Only the first posting (Rs.5) committed; the failed ones rolled back.
    assert.equal(bal.BANK.natural_balance_paise, 500);
    assert.equal(bal.INTEREST_INCOME.natural_balance_paise, 500);   // credit-normal, shown positive
    const total = await pool.query('SELECT SUM(raw_balance_paise)::bigint AS s FROM account_balances');
    assert.equal(total.rows[0].s, 0);                               // the whole ledger nets to zero
  });
});
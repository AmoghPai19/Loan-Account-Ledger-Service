// Step 5: the same repayment request sent more than once must post ONCE.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDatabase } from '../helpers/db.js';
import { createBorrower, createLoan, disburseLoan, postRepayment } from '../../src/services/loans.js';
import { trialBalance } from '../../src/ledger/ledger.js';
import { ValidationError } from '../../src/errors.js';
import { IdempotencyKeyReusedError } from '../../src/services/idempotency.js';

describe('idempotent repayments', () => {
  let pool;
  let officer;
  let manager;
  let loanId;

  /** How many REPAYMENT transactions this loan has in the ledger. */
  const repaymentCount = async () => (await pool.query(
    `SELECT count(*)::int AS n FROM ledger_transactions WHERE loan_id = $1 AND type = 'REPAYMENT'`, [loanId],
  )).rows[0].n;

  const bankBalance = async () => (await pool.query(
    `SELECT natural_balance_paise AS b FROM account_balances WHERE loan_id IS NULL AND code = 'BANK'`,
  )).rows[0].b;

  const repay = (key, overrides = {}, actor = officer) => postRepayment(pool, {
    loanId, amountPaise: 50_000, effectiveDate: '2026-02-01', idempotencyKey: key, ...overrides,
  }, actor);

  before(async () => {
    pool = await freshDatabase();
    const users = Object.fromEntries((await pool.query('SELECT username, id FROM users')).rows.map((u) => [u.username, u.id]));
    officer = users['officer.asha'];
    manager = users['manager.ravi'];
    const borrower = await createBorrower(pool, { externalRef: 'IDEM-1', fullName: 'Meena Iyer' }, officer);
    const loan = await createLoan(pool, { borrowerId: borrower.id, productCode: 'EMI', principalPaise: 5_000_000, tenure: 12 }, officer);
    await disburseLoan(pool, { loanId: loan.id, disbursedOn: '2026-01-01' }, officer);
    loanId = loan.id;
  });
  after(() => pool?.end());

  it('the same request sent twice posts once, and the repeat returns the original response', async () => {
    const first = await repay('key-A');
    const bankAfterFirst = await bankBalance();
    const second = await repay('key-A');

    assert.equal(first.replayed, false);
    assert.equal(second.replayed, true);
    assert.equal(second.transactionId, first.transactionId);
    assert.deepEqual(second.allocation, first.allocation);
    assert.equal(await repaymentCount(), 1);
    assert.equal(await bankBalance(), bankAfterFirst);      // no extra money appeared
  });

  it('a retry after a timeout (response lost) gets the stored response, even much later', async () => {
    // The client never saw the response to key-B, so it retries several times.
    const original = await repay('key-B', { amountPaise: 20_000 });
    for (let i = 0; i < 3; i++) {
      const retry = await repay('key-B', { amountPaise: 20_000 });
      assert.equal(retry.transactionId, original.transactionId);
      assert.equal(retry.replayed, true);
    }
    assert.equal(await repaymentCount(), 2);                 // key-A and key-B only
  });

  it('5 identical requests arriving at the same moment post once', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => repay('key-C', { amountPaise: 30_000 })));
    const ids = new Set(results.map((r) => r.transactionId));
    assert.equal(ids.size, 1, 'all five responses describe the same transaction');
    assert.equal(results.filter((r) => !r.replayed).length, 1, 'exactly one request actually posted');
    assert.equal(await repaymentCount(), 3);
  });

  it('the same key with a different amount is rejected (422) and posts nothing', async () => {
    await assert.rejects(repay('key-A', { amountPaise: 99_999 }), IdempotencyKeyReusedError);
    assert.equal(await repaymentCount(), 3);
  });

  it('the same key used by a different user is rejected', async () => {
    await assert.rejects(repay('key-A', {}, manager), IdempotencyKeyReusedError);
    assert.equal(await repaymentCount(), 3);
  });

  it('a failed attempt does not use up the key', async () => {
    // First attempt is invalid (date before disbursement): nothing is saved, not even the key.
    await assert.rejects(repay('key-D', { effectiveDate: '2025-12-01' }), ValidationError);
    const fixed = await repay('key-D', { effectiveDate: '2026-02-02' });
    assert.equal(fixed.replayed, false);
    assert.equal(await repaymentCount(), 4);
  });

  it('different keys are different payments, even with identical bodies', async () => {
    await repay('key-E', { amountPaise: 1_000 });
    await repay('key-F', { amountPaise: 1_000 });
    assert.equal(await repaymentCount(), 6);
  });

  it('rejects malformed keys', async () => {
    await assert.rejects(repay(''), ValidationError);
    await assert.rejects(repay('has spaces'), ValidationError);
    await assert.rejects(repay('x'.repeat(201)), ValidationError);
  });

  it('the ledger still balances after all of the above', async () => {
    assert.equal((await trialBalance(pool)).balanced, true);
  });
});
// A loan's whole life against the real database: create, disburse, repay,
// close, checking the ledger balances after every step.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDatabase } from '../helpers/db.js';
import {
  createBorrower, createLoan, disburseLoan, postRepayment, getSchedule,
} from '../../src/services/loans.js';
import { trialBalance, loanLedgerBalances } from '../../src/ledger/ledger.js';
import { ValidationError, NotFoundError, ConflictError } from '../../src/errors.js';

describe('loan lifecycle: Rs.1,00,000 EMI loan at 18% for 12 months', () => {
  let pool;
  let actor;
  let borrower;
  let loan;

  /** Company account balance by code, derived from entries. */
  const company = async (code) => (await pool.query(
    'SELECT natural_balance_paise AS b FROM account_balances WHERE loan_id IS NULL AND code = $1', [code],
  )).rows[0].b;

  /** Every transaction balanced AND the whole ledger balanced. */
  const assertLedgerBalanced = async () => {
    const bad = await pool.query(
      `SELECT transaction_id FROM ledger_entries GROUP BY transaction_id
       HAVING SUM(CASE direction WHEN 'DEBIT' THEN amount_paise ELSE -amount_paise END) <> 0`);
    assert.equal(bad.rowCount, 0, 'every transaction must balance');
    assert.equal((await trialBalance(pool)).balanced, true, 'trial balance must balance');
  };

  before(async () => {
    pool = await freshDatabase();
    actor = (await pool.query(`SELECT id FROM users WHERE username = 'officer.asha'`)).rows[0].id;
  });
  after(() => pool?.end());

  it('creates a borrower, and rejects a duplicate external reference', async () => {
    borrower = await createBorrower(pool, { externalRef: 'CUST-0001', fullName: 'Lakshmi Rao', phone: '9000000001' }, actor);
    assert.ok(borrower.id);
    await assert.rejects(
      createBorrower(pool, { externalRef: 'CUST-0001', fullName: 'Someone Else' }, actor), ConflictError);
  });

  it('rejects loans outside the product limits', async () => {
    const base = { borrowerId: borrower.id, productCode: 'EMI', principalPaise: 10_000_000, tenure: 12 };
    await assert.rejects(createLoan(pool, { ...base, principalPaise: 1_000 }, actor), ValidationError);   // below min
    await assert.rejects(createLoan(pool, { ...base, tenure: 48 }, actor), ValidationError);              // above max
    await assert.rejects(createLoan(pool, { ...base, productCode: 'NOPE' }, actor), ValidationError);
    await assert.rejects(createLoan(pool, { ...base, principalPaise: 100.5 }, actor), ValidationError);
    await assert.rejects(
      createLoan(pool, { ...base, borrowerId: '00000000-0000-0000-0000-000000000000' }, actor), NotFoundError);
  });

  it('creates a loan with the product terms copied onto it (D4)', async () => {
    loan = await createLoan(pool, { borrowerId: borrower.id, productCode: 'EMI', principalPaise: 10_000_000, tenure: 12 }, actor);
    assert.equal(loan.status, 'CREATED');
    assert.equal(loan.annual_rate_bps, 1800);
    assert.equal(loan.schedule_type, 'REDUCING');
  });

  it('cannot be repaid before it is disbursed', async () => {
    await assert.rejects(
      postRepayment(pool, { loanId: loan.id, amountPaise: 100, effectiveDate: '2026-01-20' }, actor), ConflictError);
  });

  it('disburses: stores 12 instalments and posts Dr Principal Receivable / Cr Bank', async () => {
    const result = await disburseLoan(pool, { loanId: loan.id, disbursedOn: '2026-01-15' }, actor);
    assert.equal(result.loan.status, 'DISBURSED');
    assert.equal(result.loan.first_due_date, '2026-02-15');
    assert.equal(result.schedule.length, 12);

    const bal = await loanLedgerBalances(pool, loan.id);
    assert.equal(bal.principalReceivablePaise, 10_000_000);
    assert.equal(bal.interestReceivablePaise, 0);
    assert.equal(await company('BANK'), -10_000_000);   // money left the bank
    await assertLedgerBalanced();
  });

  it('cannot be disbursed twice', async () => {
    await assert.rejects(disburseLoan(pool, { loanId: loan.id, disbursedOn: '2026-01-16' }, actor), ConflictError);
  });

  it('first EMI (Rs.9,168.00) pays instalment 1: Rs.1,500 interest then Rs.7,668 principal', async () => {
    const r = await postRepayment(pool, { loanId: loan.id, amountPaise: 916_800, effectiveDate: '2026-02-15' }, actor);
    assert.deepEqual(
      r.allocation.map((l) => [l.instalmentNo, l.component, l.amountPaise]),
      [[1, 'INTEREST', 150_000], [1, 'PRINCIPAL', 766_800]],
    );
    assert.equal(r.advancePaise, 0);
    assert.equal(r.balances.principalReceivablePaise, 10_000_000 - 766_800);
    assert.equal(r.balances.interestReceivablePaise, 0);   // recognised (D21) and paid in the same request
    assert.equal(await company('INTEREST_INCOME'), 150_000);
    assert.equal(await company('BANK'), -10_000_000 + 916_800);

    const { instalments } = await getSchedule(pool, loan.id);
    assert.equal(instalments[0].status, 'PAID');
    assert.equal(instalments[1].status, 'UNPAID');
    await assertLedgerBalanced();
  });

  it('a partial payment goes to instalment 2 interest first', async () => {
    const r = await postRepayment(pool, { loanId: loan.id, amountPaise: 100_000, effectiveDate: '2026-03-10' }, actor);
    assert.deepEqual(r.allocation.map((l) => [l.instalmentNo, l.component, l.amountPaise]), [[2, 'INTEREST', 100_000]]);
    // Instalment 2's full interest (Rs.1,384.98) is recognised; Rs.384.98 of it is still receivable.
    assert.equal(r.balances.interestReceivablePaise, 138_498 - 100_000);

    const { instalments } = await getSchedule(pool, loan.id);
    assert.equal(instalments[1].status, 'PARTIALLY_PAID');
    assert.equal(instalments[1].interestOutstandingPaise, 38_498);
    await assertLedgerBalanced();
  });

  it('paying everything plus Rs.50 closes the loan; the Rs.50 becomes a borrower advance', async () => {
    const { instalments } = await getSchedule(pool, loan.id);
    const owed = instalments.reduce((s, i) =>
      s + i.principalOutstandingPaise + i.interestOutstandingPaise + i.penaltyOutstandingPaise, 0);

    const r = await postRepayment(pool, { loanId: loan.id, amountPaise: owed + 5_000, effectiveDate: '2026-04-01' }, actor);
    assert.equal(r.loanStatus, 'CLOSED');
    assert.equal(r.advancePaise, 5_000);
    assert.equal(r.balances.totalReceivablePaise, 0);
    assert.equal(await company('BORROWER_ADVANCE'), 5_000);
    // All the contractual interest (Rs.10,015.99, from the Step 2 test) has been recognised as income.
    assert.equal(await company('INTEREST_INCOME'), 1_001_599);
    await assertLedgerBalanced();
  });

  it('a closed loan cannot be repaid again', async () => {
    await assert.rejects(
      postRepayment(pool, { loanId: loan.id, amountPaise: 100, effectiveDate: '2026-04-02' }, actor), ConflictError);
  });

  it('rejects bad repayment input', async () => {
    const other = await createLoan(pool, { borrowerId: borrower.id, productCode: 'FLT', principalPaise: 1_000_000, tenure: 12 }, actor);
    await disburseLoan(pool, { loanId: other.id, disbursedOn: '2026-01-01' }, actor);
    const base = { loanId: other.id, amountPaise: 1_000, effectiveDate: '2026-02-01' };
    await assert.rejects(postRepayment(pool, { ...base, amountPaise: 0 }, actor), ValidationError);
    await assert.rejects(postRepayment(pool, { ...base, amountPaise: 99.9 }, actor), ValidationError);
    await assert.rejects(postRepayment(pool, { ...base, effectiveDate: '2026-02-30' }, actor), ValidationError);
    await assert.rejects(postRepayment(pool, { ...base, effectiveDate: '2025-12-31' }, actor), ValidationError);
    await assert.rejects(
      postRepayment(pool, { ...base, loanId: '00000000-0000-0000-0000-000000000000' }, actor), NotFoundError);
    await assertLedgerBalanced();   // failed requests left nothing behind
  });
});
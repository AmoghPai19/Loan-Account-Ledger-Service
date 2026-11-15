// Step 8: the accrual job. Rs.1,00,000 EMI loan disbursed 2026-01-15:
// instalment 1 is Rs.9,168 (Rs.1,500 interest) due 2026-02-15, 5 grace days, 24% penalty.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDatabase } from '../helpers/db.js';
import { createBorrower, createLoan, disburseLoan, postRepayment, getSchedule } from '../../src/services/loans.js';
import { runAccruals, systemUserId, todayInIndia } from '../../src/jobs/accrual.js';
import { msUntilNext } from '../../src/jobs/scheduler.js';
import { trialBalance, loanLedgerBalances } from '../../src/ledger/ledger.js';
import { listAudit } from '../../src/audit/audit.js';

describe('accrual job', () => {
  let pool;
  let system;
  let officer;
  let loanId;

  const run = (asOf) => runAccruals(pool, { asOf, actorId: system, loanIds: [loanId] });
  const company = async (code) => (await pool.query(
    'SELECT natural_balance_paise AS b FROM account_balances WHERE loan_id IS NULL AND code = $1', [code])).rows[0].b;
  const txnCount = async () => (await pool.query(
    'SELECT count(*)::int AS n FROM ledger_transactions WHERE loan_id = $1', [loanId])).rows[0].n;

  before(async () => {
    pool = await freshDatabase();
    system = await systemUserId(pool);
    officer = (await pool.query(`SELECT id FROM users WHERE username = 'officer.asha'`)).rows[0].id;
    const b = await createBorrower(pool, { externalRef: 'ACR-1', fullName: 'Kavya Nair' }, officer);
    const l = await createLoan(pool, { borrowerId: b.id, productCode: 'EMI', principalPaise: 10_000_000, tenure: 12 }, officer);
    await disburseLoan(pool, { loanId: l.id, disbursedOn: '2026-01-15' }, system);
    loanId = l.id;
  });
  after(() => pool?.end());

  it('does nothing before the first due date', async () => {
    const t = await run('2026-02-14');
    assert.equal(t.transactions, 0);
  });

  it('recognises instalment 1 interest on its due date, dated on the due date', async () => {
    const t = await run('2026-02-15');
    assert.equal(t.interestAccruedPaise, 150_000);
    assert.equal(t.penaltyChargedPaise, 0);
    assert.equal((await loanLedgerBalances(pool, loanId)).interestReceivablePaise, 150_000);
    const { rows } = await pool.query(
      `SELECT effective_date FROM ledger_transactions WHERE loan_id = $1 AND type = 'INTEREST_ACCRUAL'`, [loanId]);
    assert.deepEqual(rows.map((r) => r.effective_date), ['2026-02-15']);
  });

  it('charges no penalty during the 5 grace days', async () => {
    assert.equal((await run('2026-02-20')).penaltyChargedPaise, 0);
  });

  it('charges Rs.60.28 penalty by 2026-03-02 (10 days late)', async () => {
    const t = await run('2026-03-02');
    assert.equal(t.penaltyChargedPaise, 6_028);
    assert.equal((await loanLedgerBalances(pool, loanId)).penaltyReceivablePaise, 6_028);
    assert.equal(await company('PENALTY_INCOME'), 6_028);
  });

  it('running it again for the same date changes nothing (D49)', async () => {
    const before = await txnCount();
    const t = await run('2026-03-02');
    assert.equal(t.transactions, 0);
    assert.equal(await txnCount(), before);
  });

  it('a payment dated 2026-02-25 that ARRIVES after that run corrects the penalty (D50)', async () => {
    // It arrives now, after the job charged 10 days. It pays the Rs.60.28 penalty first (D20),
    // then Rs.1,500 interest, then Rs.7,607.72 principal, leaving Rs.60.28 of instalment 1 unpaid.
    const r = await postRepayment(pool, { loanId, amountPaise: 916_800, effectiveDate: '2026-02-25' }, officer);
    assert.deepEqual(r.allocation.map((l) => [l.component, l.amountPaise]),
      [['PENALTY', 6_028], ['INTEREST', 150_000], ['PRINCIPAL', 760_772]]);

    // Re-run for 2026-03-02. Using the payment's REAL date, the penalty should have been only
    // Rs.24.35 (Python: Rs.9,168 overdue for 4 days, then Rs.60.28 for 6 days).
    const t = await run('2026-03-02');
    assert.equal(t.penaltyReversedPaise, 6_028 - 2_435);
    assert.equal(await company('PENALTY_INCOME'), 2_435);
    // The penalty was already paid, so the over-charge goes back to the borrower.
    assert.equal(await company('BORROWER_ADVANCE'), 6_028 - 2_435);
    assert.equal((await loanLedgerBalances(pool, loanId)).penaltyReceivablePaise, 0);
  });

  it('keeps accruing on what is still overdue, and is idempotent again afterwards', async () => {
    const t = await run('2026-03-12');
    assert.ok(t.penaltyChargedPaise > 0, 'Rs.60.28 of instalment 1 is still overdue');
    const again = await run('2026-03-12');
    assert.equal(again.transactions, 0);
  });

  it('two runs at the same moment give the same result as one (loan row lock)', async () => {
    const [a, b] = await Promise.all([run('2026-03-20'), run('2026-03-20')]);
    assert.equal(a.transactions + b.transactions > 0, true);
    assert.equal(Math.min(a.transactions, b.transactions), 0, 'one of them found nothing left to do');
    assert.equal((await run('2026-03-20')).transactions, 0);
  });

  it('writes an audit row as the system user', async () => {
    const rows = await listAudit(pool, { entityType: 'loan', entityId: loanId });
    const accruals = rows.filter((r) => r.action === 'ACCRUALS_POSTED');
    assert.ok(accruals.length > 0);
    assert.ok(accruals.every((r) => r.actor_username === 'system'));
  });

  it('the schedule shows the penalty, and the ledger balances', async () => {
    const { instalments } = await getSchedule(pool, loanId);
    assert.ok(instalments[0].penaltyAccruedPaise > 0);
    assert.equal((await trialBalance(pool)).balanced, true);
  });

  it('one failing loan does not stop the run for the others (D54)', async () => {
    const t = await runAccruals(pool, { asOf: '2026-03-25', actorId: '00000000-0000-0000-0000-000000000000', loanIds: [loanId] });
    assert.equal(t.failures.length, 1, 'an unknown actor makes this loan fail (foreign key)');
    assert.equal(t.failures[0].loanId, loanId);
    assert.equal((await trialBalance(pool)).balanced, true, 'the failed loan left nothing half-written');
  });

  it('skips loans that are not disbursed', async () => {
    const b = await createBorrower(pool, { externalRef: 'ACR-2', fullName: 'Not Disbursed' }, officer);
    const l = await createLoan(pool, { borrowerId: b.id, productCode: 'FLT', principalPaise: 1_000_000, tenure: 6 }, officer);
    const t = await runAccruals(pool, { asOf: '2026-12-31', actorId: system, loanIds: [l.id] });
    assert.equal(t.loansChecked, 0);
  });
});

describe('scheduler helpers', () => {
  it('today in India is 5:30 ahead of UTC', () => {
    assert.equal(todayInIndia(Date.parse('2026-03-01T18:29:00Z')), '2026-03-01');
    assert.equal(todayInIndia(Date.parse('2026-03-01T18:31:00Z')), '2026-03-02');
  });
  it('msUntilNext finds the next 01:00 India time', () => {
    // 2026-03-01 00:30 IST = 2026-02-28T19:00Z -> 30 minutes to 01:00 IST
    assert.equal(msUntilNext('01:00', Date.parse('2026-02-28T19:00:00Z')), 30 * 60_000);
    // 2026-03-01 01:30 IST -> next is tomorrow, 23.5 hours away
    assert.equal(msUntilNext('01:00', Date.parse('2026-02-28T20:00:00Z')), 23.5 * 3_600_000);
    assert.throws(() => msUntilNext('25:00'));
  });
});
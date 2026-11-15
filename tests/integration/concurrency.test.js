// Step 6: DIFFERENT repayments arriving on the SAME loan at the same moment
// (fired in parallel over HTTP) must leave exactly the balance they would
// have left if they had arrived one after another.
//
// Why "one after another" is easy to predict: allocation is a waterfall
// (D20), so N payments posted in sequence end up exactly where ONE payment
// of their total would. allocateRepayment(total, ...) gives the expected
// final position of every instalment.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDatabase } from '../helpers/db.js';
import { createApp } from '../../src/app.js';
import { allocateRepayment } from '../../src/domain/allocation.js';
import { getSchedule } from '../../src/services/loans.js';
import { trialBalance } from '../../src/ledger/ledger.js';

describe('parallel repayments on one loan', () => {
  let pool;
  let server;
  let base;

  async function call(method, path, body, headers = {}) {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-API-Key': 'dev-officer-key', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  }

  /** A fresh, disbursed Rs.1,00,000 EMI loan (18%, 12 months). Returns its id. */
  async function newLoan(ref) {
    const b = await call('POST', '/borrowers', { externalRef: ref, fullName: 'Parallel Test' });
    const l = await call('POST', '/loans', { borrowerId: b.body.id, productCode: 'EMI', principalPaise: 10_000_000, tenure: 12 });
    await call('POST', `/loans/${l.body.id}/disburse`, { disbursedOn: '2026-01-15' }, { 'X-API-Key': 'dev-manager-key' });
    return l.body.id;
  }

  /** Fire all payments at once (Promise.all), each with its own Idempotency-Key. */
  function fireInParallel(loanId, amounts) {
    return Promise.all(amounts.map((amountPaise, i) => call(
      'POST', `/loans/${loanId}/repayments`,
      { amountPaise, effectiveDate: '2026-02-15' },
      { 'Idempotency-Key': `${loanId}-pay-${i}` },
    )));
  }

  /** Compare every instalment with the waterfall of the total (see top of file). */
  async function assertSameAsSequential(loanId, totalPaid, before) {
    const expected = allocateRepayment(totalPaid, before.map((p) => ({
      instalmentId: p.instalmentId, instalmentNo: p.instalmentNo, dueDate: p.dueDate,
      penaltyPaise: 0, interestPaise: p.interestDuePaise, principalPaise: p.principalDuePaise,
    })));
    const paidBy = (no, component) => expected.lines
      .filter((l) => l.instalmentNo === no && l.component === component)
      .reduce((s, l) => s + l.amountPaise, 0);

    const { instalments } = await getSchedule(pool, loanId);
    for (const i of instalments) {
      const label = `instalment ${i.instalmentNo}`;
      assert.equal(i.interestPaidPaise, paidBy(i.instalmentNo, 'INTEREST'), `${label} interest paid`);
      assert.equal(i.principalPaidPaise, paidBy(i.instalmentNo, 'PRINCIPAL'), `${label} principal paid`);
      assert.ok(i.interestAccruedPaise <= i.interestDuePaise, `${label} interest recognised more than once`);
      assert.ok(i.principalPaidPaise <= i.principalDuePaise, `${label} principal overpaid`);
    }
    return expected;
  }

  before(async () => {
    pool = await freshDatabase();
    server = createApp({ pool }).listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    await new Promise((resolve) => server?.close(resolve));
    await pool?.end();
  });

  it('10 EMIs fired at once pay instalments 1-10 exactly once each', async () => {
    const loanId = await newLoan('PAR-1');
    const { instalments: before } = await getSchedule(pool, loanId);

    const results = await fireInParallel(loanId, Array(10).fill(916_800));
    assert.deepEqual(results.map((r) => r.status), Array(10).fill(201), 'every payment accepted');

    await assertSameAsSequential(loanId, 10 * 916_800, before);
    const { instalments } = await getSchedule(pool, loanId);
    assert.deepEqual(instalments.map((i) => i.status), [...Array(10).fill('PAID'), 'UNPAID', 'UNPAID']);

    // Principal still owed = exactly the principal of instalments 11 and 12.
    const loan = await call('GET', `/loans/${loanId}`);
    assert.equal(loan.body.balances.principalReceivablePaise, before[10].principalDuePaise + before[11].principalDuePaise);
    assert.equal(loan.body.balances.interestReceivablePaise, 0);
  });

  it('25 payments of different amounts fired at once give the same result as one after another', async () => {
    const loanId = await newLoan('PAR-2');
    const { instalments: before } = await getSchedule(pool, loanId);

    // 25 "random" amounts between Rs.500 and Rs.3,500, the same on every run (simple LCG).
    let seed = 42;
    const amounts = Array.from({ length: 25 }, () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return 50_000 + (seed % 300_000);
    });
    const total = amounts.reduce((s, a) => s + a, 0);

    const results = await fireInParallel(loanId, amounts);
    assert.ok(results.every((r) => r.status === 201), 'every payment accepted');

    await assertSameAsSequential(loanId, total, before);
    const loan = await call('GET', `/loans/${loanId}`);
    const principalPaid = before.reduce((s, p) => s + p.principalDuePaise, 0) - loan.body.balances.principalReceivablePaise;
    const { instalments } = await getSchedule(pool, loanId);
    assert.equal(instalments.reduce((s, i) => s + i.principalPaidPaise, 0), principalPaid);
  });

  it('payments that together overpay close the loan exactly once; later ones are refused, not lost', async () => {
    const loanId = await newLoan('PAR-3');
    const { instalments: before } = await getSchedule(pool, loanId);
    const owed = before.reduce((s, p) => s + p.principalDuePaise + p.interestDuePaise, 0);

    // 15 x Rs.9,168 = Rs.1,37,520, more than the Rs.1,10,015.99 owed.
    const results = await fireInParallel(loanId, Array(15).fill(916_800));
    const accepted = results.filter((r) => r.status === 201);
    const refused = results.filter((r) => r.status === 409);
    assert.equal(accepted.length + refused.length, 15, 'every payment either posted or was cleanly refused');
    assert.equal(accepted.filter((r) => r.body.loanStatus === 'CLOSED').length, 1, 'closed by exactly one payment');

    // Accepted money = what was owed + the borrower advance; refused payments posted nothing.
    const acceptedTotal = accepted.reduce((s, r) => s + r.body.amountPaise, 0);
    const advance = accepted.reduce((s, r) => s + r.body.advancePaise, 0);
    assert.equal(acceptedTotal - advance, owed);
    assert.ok(refused.every((r) => r.body.error.code === 'CONFLICT'));

    const loan = await call('GET', `/loans/${loanId}`);
    assert.equal(loan.body.status, 'CLOSED');
    assert.equal(loan.body.balances.totalReceivablePaise, 0);
  });

  it('the whole ledger balances after all the parallel posting', async () => {
    assert.equal((await trialBalance(pool)).balanced, true);
  });
});
// Step 7: the audit trail records who changed what, and when.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDatabase } from '../helpers/db.js';
import { createApp } from '../../src/app.js';

const KEYS = { OFFICER: 'dev-officer-key', MANAGER: 'dev-manager-key', AUDITOR: 'dev-auditor-key' };

describe('audit trail', () => {
  let pool;
  let server;
  let base;
  let loanId;
  const requestIds = {};

  async function call(role, method, path, body, extraHeaders = {}) {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-API-Key': KEYS[role], ...extraHeaders },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, requestId: res.headers.get('X-Request-Id'), body: await res.json() };
  }

  const loanHistory = async () =>
    (await call('AUDITOR', 'GET', `/audit?entityType=loan&entityId=${loanId}`)).body.reverse(); // oldest first

  const auditCount = async () => (await pool.query('SELECT count(*)::int AS n FROM audit_log')).rows[0].n;

  before(async () => {
    pool = await freshDatabase();
    server = createApp({ pool }).listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;

    // An officer creates the borrower and loan, a manager disburses, the officer takes a payment.
    const b = await call('OFFICER', 'POST', '/borrowers', { externalRef: 'AUD-1', fullName: 'Anita Desai' });
    const l = await call('OFFICER', 'POST', '/loans', { borrowerId: b.body.id, productCode: 'FLT', principalPaise: 1_000_000, tenure: 6 });
    loanId = l.body.id;
    requestIds.create = l.requestId;
    requestIds.disburse = (await call('MANAGER', 'POST', `/loans/${loanId}/disburse`, { disbursedOn: '2026-01-01' })).requestId;
    requestIds.repay = (await call('OFFICER', 'POST', `/loans/${loanId}/repayments`,
      { amountPaise: 176_667, effectiveDate: '2026-02-01' }, { 'Idempotency-Key': 'aud-pay-1' })).requestId;
  });
  after(async () => {
    await new Promise((resolve) => server?.close(resolve));
    await pool?.end();
  });

  it('records each change to the loan, in order, with who did it', async () => {
    const history = await loanHistory();
    assert.deepEqual(
      history.map((h) => [h.action, h.actorUsername]),
      [['LOAN_CREATED', 'officer.asha'], ['LOAN_DISBURSED', 'manager.ravi'], ['REPAYMENT_POSTED', 'officer.asha']],
    );
    assert.ok(history.every((h) => h.at), 'every row has a timestamp');
  });

  it('records what changed: before and after', async () => {
    const [, disbursed, repaid] = await loanHistory();
    assert.equal(disbursed.before.status, 'CREATED');
    assert.equal(disbursed.after.status, 'DISBURSED');
    assert.ok(disbursed.after.transactionId);
    assert.equal(repaid.after.amountPaise, 176_667);
    assert.equal(repaid.after.idempotencyKey, 'aud-pay-1');
    assert.ok(repaid.after.allocation.length > 0);
  });

  it('links each audit row to the HTTP request that caused it (X-Request-Id)', async () => {
    const [created, disbursed, repaid] = await loanHistory();
    assert.equal(created.requestId, requestIds.create);
    assert.equal(disbursed.requestId, requestIds.disburse);
    assert.equal(repaid.requestId, requestIds.repay);
  });

  it('records borrower creation too', async () => {
    const rows = (await call('MANAGER', 'GET', '/audit?entityType=borrower')).body;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].action, 'BORROWER_CREATED');
    assert.equal(rows[0].after.external_ref, 'AUD-1');
  });

  it('an idempotent replay writes no audit row (nothing changed)', async () => {
    const before = await auditCount();
    const r = await call('OFFICER', 'POST', `/loans/${loanId}/repayments`,
      { amountPaise: 176_667, effectiveDate: '2026-02-01' }, { 'Idempotency-Key': 'aud-pay-1' });
    assert.equal(r.body.replayed, true);
    assert.equal(await auditCount(), before);
  });

  it('failed and forbidden requests write no audit row', async () => {
    const before = await auditCount();
    await call('OFFICER', 'POST', `/loans/${loanId}/repayments`, { amountPaise: 1_000, effectiveDate: '2025-01-01' }, { 'Idempotency-Key': 'aud-bad' });
    await call('AUDITOR', 'POST', '/borrowers', { externalRef: 'AUD-2', fullName: 'Not Allowed' });
    assert.equal(await auditCount(), before);
  });

  it('records the loan closing, as part of the payment that closed it', async () => {
    const sched = (await call('OFFICER', 'GET', `/loans/${loanId}/schedule`)).body;
    await call('OFFICER', 'POST', `/loans/${loanId}/repayments`,
      { amountPaise: sched.totals.outstandingPaise, effectiveDate: '2026-03-01' }, { 'Idempotency-Key': 'aud-pay-2' });
    const history = await loanHistory();
    const [payment, closed] = history.slice(-2);
    assert.equal(payment.action, 'REPAYMENT_POSTED');
    assert.equal(closed.action, 'LOAN_CLOSED');
    assert.deepEqual([closed.before.status, closed.after.status], ['DISBURSED', 'CLOSED']);
    assert.equal(closed.requestId, payment.requestId);
  });

  it('nobody can edit or delete audit history, not even directly in the database', async () => {
    await assert.rejects(pool.query(`UPDATE audit_log SET action = 'NOTHING_HAPPENED'`), /append-only/);
    await assert.rejects(pool.query('DELETE FROM audit_log'), /append-only/);
  });

  it('only managers and auditors can read the audit trail', async () => {
    assert.equal((await call('OFFICER', 'GET', '/audit')).status, 403);
    assert.equal((await call('MANAGER', 'GET', '/audit')).status, 200);
  });
});
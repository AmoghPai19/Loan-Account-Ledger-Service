// Calls the real HTTP API (on a random free port) with Node's built-in fetch.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDatabase } from '../helpers/db.js';
import { createApp } from '../../src/app.js';

describe('REST API', () => {
  let pool;
  let server;
  let base;

  /** Small fetch wrapper: JSON in, { status, body } out. */
  async function call(method, path, { body, key = 'dev-officer-key', raw, headers: extra = {} } = {}) {
    const headers = { 'Content-Type': 'application/json', ...extra };
    if (key) headers['X-API-Key'] = key;
    const res = await fetch(base + path, {
      method,
      headers,
      body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
    return { status: res.status, headers: res.headers, body: await res.json() };
  }

  before(async () => {
    pool = await freshDatabase();
    server = createApp({ pool }).listen(0);          // 0 = any free port
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    await new Promise((resolve) => server?.close(resolve));
    await pool?.end();
  });

  it('GET /health works without a key', async () => {
    const r = await call('GET', '/health', { key: null });
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'ok');
  });

  it('rejects requests without a key, or with a wrong key (401)', async () => {
    assert.equal((await call('GET', '/products', { key: null })).status, 401);
    assert.equal((await call('GET', '/products', { key: 'wrong' })).status, 401);
  });

  it('GET /products lists the three products', async () => {
    const r = await call('GET', '/products');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.map((p) => p.code), ['EMI', 'FLT', 'WGL']);
    assert.equal(r.body[0].annualRateBps, 1800);     // camelCase in the API
  });

  it('runs a loan end to end over HTTP', async () => {
    // create borrower
    const b = await call('POST', '/borrowers', { body: { externalRef: 'API-1', fullName: 'Ravi Kumar' } });
    assert.equal(b.status, 201);
    assert.equal(b.body.externalRef, 'API-1');

    // create loan: Rs.10,000 flat-rate, 12 months
    const l = await call('POST', '/loans', {
      body: { borrowerId: b.body.id, productCode: 'FLT', principalPaise: 1_000_000, tenure: 12 },
    });
    assert.equal(l.status, 201);
    assert.equal(l.body.status, 'CREATED');
    const loanId = l.body.id;

    // disburse
    const d = await call('POST', `/loans/${loanId}/disburse`, { body: { disbursedOn: '2026-01-01' } });
    assert.equal(d.status, 200);
    assert.equal(d.body.loan.status, 'DISBURSED');
    assert.equal(d.body.instalments, 12);

    // schedule
    const s = await call('GET', `/loans/${loanId}/schedule`);
    assert.equal(s.status, 200);
    assert.equal(s.body.instalments.length, 12);
    assert.equal(s.body.totals.interestDuePaise, 120_000);           // Rs.1,200 flat interest
    assert.equal(s.body.totals.outstandingPaise, 1_120_000);
    assert.equal(s.body.instalments[0].dueDate, '2026-02-01');

    // repay the first instalment: Rs.100 interest + Rs.833.33 principal
    const repay = () => call('POST', `/loans/${loanId}/repayments`, {
      body: { amountPaise: 93_333, effectiveDate: '2026-02-01', externalEventId: 'UPI-0001' },
      headers: { 'Idempotency-Key': 'api-test-repay-1' },
    });
    const p = await repay();
    assert.equal(p.status, 201);
    assert.equal(p.headers.get('Idempotent-Replayed'), 'false');
    assert.deepEqual(p.body.allocation.map((a) => [a.component, a.amountPaise]), [['INTEREST', 10_000], ['PRINCIPAL', 83_333]]);

    // Step 5: the same request again (a client retry) is replayed, not posted twice.
    const again = await repay();
    assert.equal(again.status, 201);
    assert.equal(again.headers.get('Idempotent-Replayed'), 'true');
    assert.equal(again.body.transactionId, p.body.transactionId);

    // loan view shows ledger-derived balances
    const g = await call('GET', `/loans/${loanId}`);
    assert.equal(g.status, 200);
    assert.equal(g.body.balances.principalReceivablePaise, 1_000_000 - 83_333);

    // ledger still balances
    const tb = await call('GET', '/ledger/trial-balance');
    assert.equal(tb.body.balanced, true);
  });

  it('returns 400 with a clear error for invalid input', async () => {
    const r = await call('POST', '/borrowers', { body: { externalRef: '', fullName: 'X' } });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'VALIDATION_ERROR');
    assert.match(r.body.error.message, /externalRef/);
  });

  it('returns 400 for malformed JSON', async () => {
    const r = await call('POST', '/borrowers', { raw: '{"externalRef": ' });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'INVALID_JSON');
  });

  it('returns 404 for unknown or malformed ids, and unknown routes', async () => {
    assert.equal((await call('GET', '/loans/00000000-0000-0000-0000-000000000000')).status, 404);
    assert.equal((await call('GET', '/loans/not-a-uuid')).status, 404);
    assert.equal((await call('GET', '/nothing-here')).status, 404);
  });

  it('requires an Idempotency-Key on repayments (400 without one)', async () => {
    const r = await call('POST', '/loans/00000000-0000-0000-0000-000000000000/repayments', {
      body: { amountPaise: 100, effectiveDate: '2026-02-01' },
    });
    assert.equal(r.status, 400);
    assert.match(r.body.error.message, /Idempotency-Key/);
  });

  it('returns 409 for a conflict (duplicate borrower)', async () => {
    const r = await call('POST', '/borrowers', { body: { externalRef: 'API-1', fullName: 'Again' } });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'CONFLICT');
  });
});
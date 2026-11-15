// Step 7: every endpoint, called by every role, over HTTP.
// "allowed" means anything except 403; "denied" means exactly 403.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDatabase } from '../helpers/db.js';
import { createApp } from '../../src/app.js';

const KEYS = { OFFICER: 'dev-officer-key', MANAGER: 'dev-manager-key', AUDITOR: 'dev-auditor-key' };

describe('role-based access over HTTP', () => {
  let pool;
  let server;
  let base;
  let borrowerId;
  let createdLoanId;
  let disbursedLoanId;

  async function call(role, method, path, body, extraHeaders = {}) {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-API-Key': KEYS[role], ...extraHeaders },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  }

  before(async () => {
    pool = await freshDatabase();
    server = createApp({ pool }).listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;

    borrowerId = (await call('MANAGER', 'POST', '/borrowers', { externalRef: 'RBAC-0', fullName: 'Fixture' })).body.id;
    const newLoan = async () => (await call('MANAGER', 'POST', '/loans',
      { borrowerId, productCode: 'FLT', principalPaise: 1_000_000, tenure: 12 })).body.id;
    createdLoanId = await newLoan();
    disbursedLoanId = await newLoan();
    await call('MANAGER', 'POST', `/loans/${disbursedLoanId}/disburse`, { disbursedOn: '2026-01-01' });
  });
  after(async () => {
    await new Promise((resolve) => server?.close(resolve));
    await pool?.end();
  });

  it('GET /me reports each key\'s role', async () => {
    for (const role of Object.keys(KEYS)) {
      const r = await call(role, 'GET', '/me');
      assert.equal(r.status, 200);
      assert.equal(r.body.role, role);
    }
  });

  // [description, method, path (function, so ids exist), body, roles allowed]
  const cases = [
    ['list products', 'GET', () => '/products', undefined, ['OFFICER', 'MANAGER', 'AUDITOR']],
    ['view a borrower', 'GET', () => `/borrowers/${borrowerId}`, undefined, ['OFFICER', 'MANAGER', 'AUDITOR']],
    ['view a loan', 'GET', () => `/loans/${disbursedLoanId}`, undefined, ['OFFICER', 'MANAGER', 'AUDITOR']],
    ['view a schedule', 'GET', () => `/loans/${disbursedLoanId}/schedule`, undefined, ['OFFICER', 'MANAGER', 'AUDITOR']],
    ['create a borrower', 'POST', () => '/borrowers', (role) => ({ externalRef: `RBAC-${role}`, fullName: role }), ['OFFICER', 'MANAGER']],
    ['create a loan', 'POST', () => '/loans', () => ({ borrowerId, productCode: 'FLT', principalPaise: 1_000_000, tenure: 12 }), ['OFFICER', 'MANAGER']],
    ['disburse a loan', 'POST', () => `/loans/${createdLoanId}/disburse`, () => ({ disbursedOn: '2026-01-01' }), ['MANAGER']],
    ['post a repayment', 'POST', () => `/loans/${disbursedLoanId}/repayments`, () => ({ amountPaise: 1_000, effectiveDate: '2026-02-01' }), ['OFFICER', 'MANAGER']],
    ['view the trial balance', 'GET', () => '/ledger/trial-balance', undefined, ['MANAGER', 'AUDITOR']],
    ['view the audit trail', 'GET', () => '/audit', undefined, ['MANAGER', 'AUDITOR']],
  ];

  for (const [what, method, path, body, allowed] of cases) {
    it(`${what}: allowed for ${allowed.join(', ')}`, async () => {
      // Denied roles first, so a write by an allowed role can't change what they would see.
      const roles = Object.keys(KEYS).sort((a, b) => allowed.includes(a) - allowed.includes(b));
      for (const role of roles) {
        const r = await call(role, method, path(), body?.(role), { 'Idempotency-Key': `rbac-${what}-${role}` });
        if (allowed.includes(role)) {
          assert.notEqual(r.status, 403, `${role} should be allowed to ${what}`);
        } else {
          assert.equal(r.status, 403, `${role} should NOT be allowed to ${what}`);
          assert.equal(r.body.error.code, 'FORBIDDEN');
        }
      }
    });
  }

  it('a denied request changes nothing', async () => {
    const r = await call('AUDITOR', 'POST', `/loans/${disbursedLoanId}/repayments`,
      { amountPaise: 5_000, effectiveDate: '2026-02-01' }, { 'Idempotency-Key': 'auditor-tries' });
    assert.equal(r.status, 403);
    const n = await pool.query(`SELECT count(*)::int AS n FROM ledger_transactions WHERE idempotency_key = 'auditor-tries'`);
    assert.equal(n.rows[0].n, 0);
  });
});
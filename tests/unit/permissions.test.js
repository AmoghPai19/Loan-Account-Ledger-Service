import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { can, PERMISSIONS } from '../../src/http/authorize.js';

describe('role permissions (D41, D42, D43)', () => {
  it('everyone can read', () => {
    for (const role of ['OFFICER', 'MANAGER', 'AUDITOR']) assert.ok(can(role, 'read'), role);
  });
  it('only managers can disburse (maker-checker)', () => {
    assert.equal(can('MANAGER', 'loan:disburse'), true);
    assert.equal(can('OFFICER', 'loan:disburse'), false);
    assert.equal(can('AUDITOR', 'loan:disburse'), false);
  });
  it('auditors can change nothing', () => {
    for (const p of ['borrower:create', 'loan:create', 'loan:disburse', 'repayment:post']) {
      assert.equal(can('AUDITOR', p), false, p);
    }
  });
  it('officers cannot see the trial balance or the audit trail', () => {
    assert.equal(can('OFFICER', 'ledger:read'), false);
    assert.equal(can('OFFICER', 'audit:read'), false);
  });
  it('unknown roles get nothing, unknown permissions are a programming error', () => {
    for (const p of Object.keys(PERMISSIONS)) assert.equal(can('INTERN', p), false, p);
    assert.throws(() => can('MANAGER', 'loan:delete'));
  });
});
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { allocateRepayment } from '../../src/domain/allocation.js';

// Two instalments; instalment 1 is older. Amounts in paise.
const owed = () => [
  { instalmentId: 'i2', instalmentNo: 2, dueDate: '2026-03-15', penaltyPaise: 50, interestPaise: 1_000, principalPaise: 9_000 },
  { instalmentId: 'i1', instalmentNo: 1, dueDate: '2026-02-15', penaltyPaise: 30, interestPaise: 1_200, principalPaise: 8_800 },
];
const summary = (r) => r.lines.map((l) => `${l.instalmentNo}:${l.component}:${l.amountPaise}`);

describe('allocateRepayment (D20)', () => {
  it('pays all penalties first, oldest first', () => {
    assert.deepEqual(summary(allocateRepayment(60, owed())), ['1:PENALTY:30', '2:PENALTY:30']);
  });

  it('then interest before principal, oldest instalment first', () => {
    const r = allocateRepayment(80 + 1_200 + 500, owed());
    assert.deepEqual(summary(r), ['1:PENALTY:30', '2:PENALTY:50', '1:INTEREST:1200', '1:PRINCIPAL:500']);
    assert.equal(r.unallocatedPaise, 0);
  });

  it('finishes the older instalment before starting the next', () => {
    const r = allocateRepayment(80 + 10_000 + 100, owed());
    assert.deepEqual(summary(r).slice(-3), ['1:INTEREST:1200', '1:PRINCIPAL:8800', '2:INTEREST:100']);
  });

  it('returns anything beyond the total owed as unallocated', () => {
    const totalOwed = 30 + 1_200 + 8_800 + 50 + 1_000 + 9_000;
    const r = allocateRepayment(totalOwed + 777, owed());
    assert.equal(r.unallocatedPaise, 777);
    assert.equal(r.lines.reduce((s, l) => s + l.amountPaise, 0), totalOwed);
  });

  it('allocated + unallocated always equals the payment', () => {
    for (const amount of [1, 79, 80, 81, 1_279, 10_080, 20_079, 20_080, 50_000]) {
      const r = allocateRepayment(amount, owed());
      assert.equal(r.lines.reduce((s, l) => s + l.amountPaise, 0) + r.unallocatedPaise, amount, `amount ${amount}`);
    }
  });

  it('skips components that are already paid (zero owed)', () => {
    const r = allocateRepayment(100, [
      { instalmentId: 'a', instalmentNo: 1, dueDate: '2026-01-01', penaltyPaise: 0, interestPaise: 0, principalPaise: 40 },
      { instalmentId: 'b', instalmentNo: 2, dueDate: '2026-02-01', penaltyPaise: 0, interestPaise: 10, principalPaise: 100 },
    ]);
    assert.deepEqual(summary(r), ['1:PRINCIPAL:40', '2:INTEREST:10', '2:PRINCIPAL:50']);
  });

  it('does not change the array it was given', () => {
    const input = owed();
    const before = JSON.stringify(input);
    allocateRepayment(5_000, input);
    assert.equal(JSON.stringify(input), before);
  });

  it('rejects zero, negative and fractional amounts', () => {
    assert.throws(() => allocateRepayment(0, owed()));
    assert.throws(() => allocateRepayment(-5, owed()));
    assert.throws(() => allocateRepayment(10.5, owed()));
  });
});
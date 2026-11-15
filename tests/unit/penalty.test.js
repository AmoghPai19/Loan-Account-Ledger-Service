import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { penaltyThrough } from '../../src/domain/penalty.js';

// Expected values were calculated independently, day by day, in Python.
// Instalment: Rs.9,168 due 2026-02-15, 5 grace days, 24% p.a. penalty.
const base = { dueDate: '2026-02-15', graceDays: 5, overdueBasePaise: 916_800, payments: [], penaltyRateBps: 2400 };

describe('penaltyThrough (D48)', () => {
  it('nothing during the grace period', () => {
    assert.equal(penaltyThrough({ ...base, asOf: '2026-02-15' }), 0);
    assert.equal(penaltyThrough({ ...base, asOf: '2026-02-20' }), 0);
  });
  it('one day after grace: Rs.9,168 x 24% / 365 = Rs.6.03', () => {
    assert.equal(penaltyThrough({ ...base, asOf: '2026-02-21' }), 603);
  });
  it('ten days after grace: Rs.60.28 (summed exactly, rounded once)', () => {
    assert.equal(penaltyThrough({ ...base, asOf: '2026-03-02' }), 6_028);
  });
  it('stops on the day the instalment is paid in full', () => {
    assert.equal(penaltyThrough({ ...base, asOf: '2026-03-02', payments: [{ date: '2026-02-25', amountPaise: 916_800 }] }), 2_411);
  });
  it('a part payment reduces the daily charge from its date', () => {
    assert.equal(penaltyThrough({ ...base, asOf: '2026-03-02', payments: [{ date: '2026-02-23', amountPaise: 400_000 }] }), 3_924);
  });
  it('paying within the grace period means no penalty at all', () => {
    assert.equal(penaltyThrough({ ...base, asOf: '2026-03-02', payments: [{ date: '2026-02-18', amountPaise: 916_800 }] }), 0);
  });
  it('payment order in the list does not matter, only their dates', () => {
    const payments = [{ date: '2026-02-27', amountPaise: 300_000 }, { date: '2026-02-22', amountPaise: 200_000 }];
    assert.equal(
      penaltyThrough({ ...base, asOf: '2026-03-02', payments }),
      penaltyThrough({ ...base, asOf: '2026-03-02', payments: [...payments].reverse() }),
    );
  });
  it('weekly group loan: Rs.448.85 due 2026-03-09, 2 grace days, 36% p.a., to 2026-03-31', () => {
    assert.equal(penaltyThrough({
      dueDate: '2026-03-09', graceDays: 2, overdueBasePaise: 44_885, payments: [], asOf: '2026-03-31', penaltyRateBps: 3600,
    }), 885);
  });
});
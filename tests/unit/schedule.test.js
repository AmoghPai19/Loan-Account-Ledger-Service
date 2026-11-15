import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSchedule, scheduleTotals, emiAmount, periodicRate, firstDueDateFor,
} from '../../src/domain/schedule.js';
import { assertFields } from '../helpers/assert.js';

// Expected values below were calculated independently (Python Decimal, and
// checked against the spreadsheet PMT formula), not copied from this code.

describe('reducing-balance EMI, monthly: Rs.1,00,000 at 18% for 12 months', () => {
  const rows = buildSchedule({
    principalPaise: 10_000_000, annualRateBps: 1800, tenure: 12,
    frequency: 'MONTHLY', scheduleType: 'REDUCING', firstDueDate: '2026-02-15',
  });

  it('EMI is Rs.9,168.00 (PMT gives 9,167.9993)', () => {
    assert.equal(emiAmount(10_000_000, periodicRate(1800, 'MONTHLY'), 12), 916_800);
  });
  it('month 1: interest Rs.1,500.00 on the full balance, principal Rs.7,668.00', () => {
    assertFields(rows[0], { interestDuePaise: 150_000, principalDuePaise: 766_800, totalDuePaise: 916_800 });
  });
  it('month 2: interest falls as the balance falls', () => {
    assertFields(rows[1], { interestDuePaise: 138_498, principalDuePaise: 778_302 });
  });
  it('last month clears the principal exactly, so its total is 1 paisa less than the EMI (D18)', () => {
    assertFields(rows[11], { principalDuePaise: 903_250, interestDuePaise: 13_549, totalDuePaise: 916_799, closingPrincipalPaise: 0 });
  });
  it('total interest is Rs.10,015.99', () => {
    assert.equal(scheduleTotals(rows).interestPaise, 1_001_599);
  });
});

describe('reducing-balance EMI, weekly: Rs.20,000 at 24% for 50 weeks', () => {
  const rows = buildSchedule({
    principalPaise: 2_000_000, annualRateBps: 2400, tenure: 50,
    frequency: 'WEEKLY', scheduleType: 'REDUCING', firstDueDate: '2026-03-02',
  });
  it('weekly EMI Rs.448.85, first interest Rs.92.31', () => {
    assertFields(rows[0], { totalDuePaise: 44_885, interestDuePaise: 9_231, principalDuePaise: 35_654 });
  });
  it('last week closes the loan; total interest Rs.2,442.29', () => {
    assertFields(rows[49], { totalDuePaise: 44_864, closingPrincipalPaise: 0 });
    assert.equal(scheduleTotals(rows).interestPaise, 244_229);
  });
  it('due dates are weekly, starting on the first due date', () => {
    assert.equal(rows[0].dueDate, '2026-03-02');
    assert.equal(rows[1].dueDate, '2026-03-09');
  });
});

describe('flat rate: Rs.10,000 at 12% flat for 12 months', () => {
  const rows = buildSchedule({
    principalPaise: 1_000_000, annualRateBps: 1200, tenure: 12,
    frequency: 'MONTHLY', scheduleType: 'FLAT', firstDueDate: '2026-02-01',
  });
  it('total interest is Rs.1,200 (on the original principal, for the full year)', () => {
    assert.equal(scheduleTotals(rows).interestPaise, 120_000);
  });
  it('Rs.100 interest every month; principal 11 x Rs.833.33 then Rs.833.37 (D2a)', () => {
    assert.ok(rows.every((r) => r.interestDuePaise === 10_000));
    assert.ok(rows.slice(0, 11).every((r) => r.principalDuePaise === 83_333));
    assert.equal(rows[11].principalDuePaise, 83_337);
  });
  it('flat interest costs more than reducing at the same headline rate', () => {
    const reducing = buildSchedule({
      principalPaise: 1_000_000, annualRateBps: 1200, tenure: 12,
      frequency: 'MONTHLY', scheduleType: 'REDUCING', firstDueDate: '2026-02-01',
    });
    assert.ok(scheduleTotals(reducing).interestPaise < 120_000);
  });
});

describe('edge cases', () => {
  it('0% rate: no interest, principal split evenly', () => {
    const rows = buildSchedule({
      principalPaise: 100_000, annualRateBps: 0, tenure: 3,
      frequency: 'MONTHLY', scheduleType: 'REDUCING', firstDueDate: '2026-01-01',
    });
    assert.deepEqual(rows.map((r) => r.principalDuePaise), [33_333, 33_333, 33_334]);
    assert.equal(scheduleTotals(rows).interestPaise, 0);
  });
  it('a single-instalment loan', () => {
    const [row] = buildSchedule({
      principalPaise: 500_000, annualRateBps: 1200, tenure: 1,
      frequency: 'MONTHLY', scheduleType: 'REDUCING', firstDueDate: '2026-01-01',
    });
    assertFields(row, { principalDuePaise: 500_000, interestDuePaise: 5_000 });
  });
  it('rejects bad input', () => {
    const ok = {
      principalPaise: 100_000, annualRateBps: 1200, tenure: 3,
      frequency: 'MONTHLY', scheduleType: 'FLAT', firstDueDate: '2026-01-01',
    };
    assert.throws(() => buildSchedule({ ...ok, principalPaise: 0 }));
    assert.throws(() => buildSchedule({ ...ok, principalPaise: 100.5 }));
    assert.throws(() => buildSchedule({ ...ok, tenure: 0 }));
    assert.throws(() => buildSchedule({ ...ok, annualRateBps: -1 }));
    assert.throws(() => buildSchedule({ ...ok, frequency: 'DAILY' }));
    assert.throws(() => buildSchedule({ ...ok, firstDueDate: '2026-02-30' }));
  });
  it('first due date is one period after disbursement', () => {
    assert.equal(firstDueDateFor('2026-01-31', 'MONTHLY'), '2026-02-28');
    assert.equal(firstDueDateFor('2026-01-31', 'WEEKLY'), '2026-02-07');
  });
});

// Property test: rules that must hold for EVERY loan, checked over a grid of
// 2 types x 2 frequencies x 6 amounts x 5 rates x 5 tenures = 600 loans.
describe('invariants over 600 loans', () => {
  const types = ['FLAT', 'REDUCING'];
  const freqs = ['WEEKLY', 'MONTHLY'];
  const amounts = [100, 99_999, 500_000, 1_234_567, 10_000_001, 50_000_000];
  const rates = [0, 1, 1200, 2400, 3650];
  const tenures = [1, 6, 12, 25, 52];

  it('principal sums exactly, nothing negative, balance ends at 0, dates increase', () => {
    let checked = 0;
    for (const scheduleType of types) for (const frequency of freqs)
    for (const principalPaise of amounts) for (const annualRateBps of rates)
    for (const tenure of tenures) {
      const rows = buildSchedule({ principalPaise, annualRateBps, tenure, frequency, scheduleType, firstDueDate: '2026-01-31' });
      const label = `${scheduleType}/${frequency}/${principalPaise}/${annualRateBps}/${tenure}`;
      assert.equal(rows.length, tenure, label);
      assert.equal(scheduleTotals(rows).principalPaise, principalPaise, label);
      assert.equal(rows.at(-1).closingPrincipalPaise, 0, label);
      for (const [k, r] of rows.entries()) {
        assert.ok(r.principalDuePaise >= 0 && r.interestDuePaise >= 0, label);
        assert.equal(r.totalDuePaise, r.principalDuePaise + r.interestDuePaise, label);
        if (k > 0) assert.ok(r.dueDate > rows[k - 1].dueDate, label);
      }
      checked++;
    }
    assert.equal(checked, 600);
  });
});
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, addMonths, daysBetween, assertIsoDate } from '../../src/domain/dates.js';
import { dueDates } from '../../src/domain/schedule.js';

describe('dates (D13, D16)', () => {
  it('clamps to month end', () => {
    assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
    assert.equal(addMonths('2028-01-31', 1), '2028-02-29'); // leap year
    assert.equal(addMonths('2026-12-15', 1), '2027-01-15'); // year rollover
  });
  it('anchors monthly due dates to the first due date instead of chaining', () => {
    assert.deepEqual(dueDates('2026-01-31', 4, 'MONTHLY'),
      ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
  });
  it('weekly due dates are 7 days apart', () => {
    assert.deepEqual(dueDates('2026-03-02', 3, 'WEEKLY'), ['2026-03-02', '2026-03-09', '2026-03-16']);
  });
  it('days arithmetic does not depend on the timezone', () => {
    assert.equal(addDays('2026-03-31', 1), '2026-04-01');
    assert.equal(daysBetween('2026-02-01', '2026-03-01'), 28);
  });
  it('rejects impossible dates instead of rolling them over', () => {
    assert.throws(() => assertIsoDate('2026-02-30'));
    assert.throws(() => assertIsoDate('03/02/2026'));
  });
});
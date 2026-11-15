import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  rupeesToPaise, roundToPaise, splitEvenly, formatPaise, bpsToFraction, sumPaise, D,
} from '../../src/domain/money.js';

describe('why we do not use floats (D1)', () => {
  it('floating point cannot even add 0.10 + 0.20 exactly', () => {
    assert.notEqual(0.1 + 0.2, 0.3);                       // 0.30000000000000004
    assert.equal(rupeesToPaise('0.10') + rupeesToPaise('0.20'), rupeesToPaise('0.30'));
  });
});

describe('rupeesToPaise', () => {
  it('parses exactly', () => {
    assert.equal(rupeesToPaise('1234.56'), 123456);
    assert.equal(rupeesToPaise('1234.5'), 123450);
    assert.equal(rupeesToPaise('1234'), 123400);
    assert.equal(rupeesToPaise('0.07'), 7);
  });
  it('rejects more than 2 decimals instead of silently rounding', () => {
    assert.throws(() => rupeesToPaise('1.005'));
    assert.throws(() => rupeesToPaise('abc'));
  });
});

describe('roundToPaise: half-up (D2)', () => {
  it('rounds .5 up and below .5 down', () => {
    assert.equal(roundToPaise('100.5'), 101);
    assert.equal(roundToPaise('100.4999'), 100);
    assert.equal(roundToPaise('100.5000001'), 101);
  });
  it('one month of 18% p.a. interest on Rs.1,00,000', () => {
    const interest = new D(10_000_000).mul(bpsToFraction(1800)).div(12);
    assert.equal(roundToPaise(interest), 150_000);           // Rs.1,500.00
  });
});

describe('splitEvenly: remainder goes on the last part (D2a)', () => {
  it('Rs.10,000 over 12 months: 11 x 83,333 then 83,337', () => {
    const parts = splitEvenly(1_000_000, 12);
    assert.ok(parts.slice(0, 11).every((p) => p === 83_333));
    assert.equal(parts[11], 83_337);
    assert.equal(sumPaise(parts), 1_000_000);
  });
  it('never produces a negative part (the case that breaks plain half-up)', () => {
    const parts = splitEvenly(30, 52);
    assert.ok(parts.every((p) => p >= 0));
    assert.equal(sumPaise(parts), 30);
  });
  it('always sums exactly, for many awkward inputs', () => {
    for (const total of [0, 1, 7, 99, 100_001, 9_999_999]) {
      for (const n of [1, 3, 7, 12, 25, 52]) {
        assert.equal(sumPaise(splitEvenly(total, n)), total, `${total} over ${n}`);
      }
    }
  });
});

describe('formatPaise', () => {
  it('uses Indian digit grouping', () => {
    assert.equal(formatPaise(12_345_678), '\u20B91,23,456.78');
    assert.equal(formatPaise(5), '\u20B90.05');
    assert.equal(formatPaise(-250), '-\u20B92.50');
  });
});
// =====================================================================
// money.js: the ONLY place where money is parsed, rounded, or split.
//
// D1  Amounts are integers of paise. Never floats.
// D2  Computed amounts (e.g. interest = balance x rate) are calculated at
//     full precision with decimal.js and rounded ONCE, half-up, to a paisa.
// D2a Equal splits use the integer quotient, and the remainder goes on the
//     LAST part (see splitEvenly for why this isn't plain half-up).
// D3  Rates are integers of basis points (2400 = 24.00%).
// =====================================================================
import Decimal from 'decimal.js';

// A dedicated Decimal configuration, so other code can't change our rounding.
// 40 significant digits is far more than (1 + i)^n needs for any realistic tenure.
export const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

/** Throws unless `value` is a whole number of paise. Returns it unchanged. */
export function assertPaise(value, label = 'amount') {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${label} must be a whole number of paise, got ${value}`);
  }
  return value;
}

export function assertNonNegativePaise(value, label = 'amount') {
  assertPaise(value, label);
  if (value < 0) throw new RangeError(`${label} must not be negative, got ${value}`);
  return value;
}

/**
 * Parse a rupee string such as "1234.5" or "1234.56" into paise, exactly.
 * Strings, not numbers: the number 0.1 is already inexact before we see it.
 * More than 2 decimal places is rejected rather than silently rounded.
 */
export function rupeesToPaise(rupees) {
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(String(rupees).trim());
  if (!match) throw new RangeError(`Not a valid rupee amount: "${rupees}"`);
  const [, sign, whole, frac = ''] = match;
  const paise = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  return assertPaise(sign === '-' ? -paise : paise, 'rupees');
}

/** Round a high-precision value to whole paise, half-up (0.5 goes away from zero). */
export function roundToPaise(value) {
  const rounded = new D(value).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
  return assertPaise(rounded.toNumber(), 'rounded amount');
}

/** Convert basis points to a decimal fraction: 2400 -> 0.24 (exact). */
export function bpsToFraction(bps) {
  if (!Number.isInteger(bps) || bps < 0) throw new RangeError(`Invalid basis points: ${bps}`);
  return new D(bps).div(10_000);
}

/**
 * Split `total` paise into `parts` equal pieces whose sum is EXACTLY `total`.
 * Every piece is floor(total / parts); the remainder (0 ... parts-1 paise)
 * goes on the last piece.
 *
 * Why floor and not half-up (D2a)? With half-up, the first n-1 pieces can
 * round UP and together exceed the total, leaving a NEGATIVE last piece.
 * Example: 30 paise over 52 weeks -> 0.58 rounds to 1, 51 x 1 = 51 > 30,
 * so the last piece would be -21. Flooring guarantees every piece is >= 0
 * and the last is at most (parts - 1) paise bigger than the others.
 */
export function splitEvenly(total, parts) {
  assertNonNegativePaise(total, 'total');
  if (!Number.isInteger(parts) || parts <= 0) throw new RangeError('parts must be a positive integer');
  const base = Math.floor(total / parts);
  const pieces = new Array(parts).fill(base);
  pieces[parts - 1] = total - base * (parts - 1);
  return pieces;
}

/** Format paise for humans in Indian digit grouping: 12345678 -> "Rs.1,23,456.78". */
export function formatPaise(paise) {
  assertPaise(paise);
  const sign = paise < 0 ? '-' : '';
  const abs = Math.abs(paise);
  const rupees = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, '0');
  return `${sign}\u20B9${new Intl.NumberFormat('en-IN').format(rupees)}.${frac}`;
}

/** Sum a list of paise amounts, staying in exact integer arithmetic. */
export function sumPaise(values) {
  return assertPaise(values.reduce((acc, v) => acc + v, 0), 'sum');
}
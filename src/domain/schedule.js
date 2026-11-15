// =====================================================================
// schedule.js: turns loan terms into a repayment schedule.
//
// Pure functions only: no database, no clock. Same input -> same output,
// which makes every rule here easy to unit test.
//
// Input:  { principalPaise, annualRateBps, tenure, frequency, scheduleType, firstDueDate }
//           frequency    = 'WEEKLY' | 'MONTHLY'
//           scheduleType = 'FLAT' | 'REDUCING'
// Output: one row per instalment:
//         { instalmentNo, dueDate, openingPrincipalPaise, principalDuePaise,
//           interestDuePaise, totalDuePaise, closingPrincipalPaise }
// =====================================================================
import { D, assertPaise, bpsToFraction, roundToPaise, splitEvenly } from './money.js';
import { addDays, addMonths, assertIsoDate } from './dates.js';

/** D17: nominal periodic rate = annual rate / periods per year. */
export const PERIODS_PER_YEAR = Object.freeze({ WEEKLY: 52, MONTHLY: 12 });

export function periodicRate(annualRateBps, frequency) {
  return bpsToFraction(annualRateBps).div(PERIODS_PER_YEAR[frequency]);
}

/** D16: the first instalment falls one period after disbursement. */
export function firstDueDateFor(disbursedOn, frequency) {
  return frequency === 'WEEKLY' ? addDays(disbursedOn, 7) : addMonths(disbursedOn, 1);
}

/**
 * D16: due dates are always computed from the FIRST due date (k periods
 * later), never by chaining "previous + 1 month". Chaining drifts:
 * 31 Jan -> 28 Feb -> 28 Mar -> ... would lose the 31st forever. Anchoring
 * gives 31 Jan -> 28 Feb -> 31 Mar -> 30 Apr.
 */
export function dueDates(firstDueDate, tenure, frequency) {
  return Array.from({ length: tenure }, (_, k) =>
    frequency === 'WEEKLY' ? addDays(firstDueDate, 7 * k) : addMonths(firstDueDate, k));
}

/**
 * EMI = P x i x (1+i)^n / ((1+i)^n - 1), rounded half-up to the paisa (D2).
 * With a 0% rate this formula divides by zero, so EMI = P / n instead.
 * `i` is a Decimal (from periodicRate).
 */
export function emiAmount(principalPaise, i, n) {
  if (i.isZero()) return roundToPaise(new D(principalPaise).div(n));
  const growth = i.plus(1).pow(n);
  return roundToPaise(new D(principalPaise).mul(i).mul(growth).div(growth.minus(1)));
}

function validate(input) {
  assertPaise(input.principalPaise, 'principal');
  if (input.principalPaise <= 0) throw new RangeError('principal must be positive');
  if (!Number.isInteger(input.tenure) || input.tenure <= 0) {
    throw new RangeError('tenure must be a positive whole number of instalments');
  }
  if (!(input.frequency in PERIODS_PER_YEAR)) throw new RangeError(`Unknown frequency ${input.frequency}`);
  if (input.scheduleType !== 'FLAT' && input.scheduleType !== 'REDUCING') {
    throw new RangeError(`Unknown schedule type ${input.scheduleType}`);
  }
  bpsToFraction(input.annualRateBps); // validates the rate
  assertIsoDate(input.firstDueDate);
}

export function buildSchedule(input) {
  validate(input);
  return input.scheduleType === 'FLAT' ? buildFlat(input) : buildReducing(input);
}

/** Builds one schedule row and moves the running balance forward. */
function makeRows(dates, P, principalFor, interestFor) {
  let outstanding = P;
  return dates.map((dueDate, k) => {
    const interest = interestFor(k, outstanding);
    const principal = principalFor(k, outstanding, interest);
    const row = {
      instalmentNo: k + 1,
      dueDate,
      openingPrincipalPaise: outstanding,
      principalDuePaise: principal,
      interestDuePaise: interest,
      totalDuePaise: principal + interest,
      closingPrincipalPaise: outstanding - principal,
    };
    outstanding -= principal;
    return row;
  });
}

/**
 * FLAT: interest is charged on the ORIGINAL principal for the whole term.
 *   total interest = P x annual rate x (tenure / periods per year)
 * Principal and interest are each split equally; remainders go on the last
 * instalment (D2a).
 */
function buildFlat({ principalPaise: P, annualRateBps, tenure: n, frequency, firstDueDate }) {
  const years = new D(n).div(PERIODS_PER_YEAR[frequency]);
  const totalInterest = roundToPaise(new D(P).mul(bpsToFraction(annualRateBps)).mul(years));
  const principalParts = splitEvenly(P, n);
  const interestParts = splitEvenly(totalInterest, n);

  return makeRows(
    dueDates(firstDueDate, n, frequency),
    P,
    (k) => principalParts[k],
    (k) => interestParts[k],
  );
}

/**
 * REDUCING: interest each period is charged only on what is still owed.
 *   interest_k  = round(outstanding x i)
 *   principal_k = EMI - interest_k
 * D18: the LAST instalment repays exactly the remaining principal, so
 * rounding can never leave a stray paisa owing (or overpaid). Its total
 * may therefore differ from the EMI by a few paise.
 */
function buildReducing({ principalPaise: P, annualRateBps, tenure: n, frequency, firstDueDate }) {
  const i = periodicRate(annualRateBps, frequency);
  const emi = emiAmount(P, i, n);

  return makeRows(
    dueDates(firstDueDate, n, frequency),
    P,
    (k, outstanding, interest) =>
      k === n - 1
        ? outstanding
        // Guard: never let principal go below 0 or above what is still owed.
        : Math.min(Math.max(emi - interest, 0), outstanding),
    (k, outstanding) => roundToPaise(new D(outstanding).mul(i)),
  );
}

/** Totals, handy for API responses and tests. */
export function scheduleTotals(rows) {
  return rows.reduce(
    (t, r) => ({
      principalPaise: t.principalPaise + r.principalDuePaise,
      interestPaise: t.interestPaise + r.interestDuePaise,
      totalPaise: t.totalPaise + r.totalDuePaise,
    }),
    { principalPaise: 0, interestPaise: 0, totalPaise: 0 },
  );
}
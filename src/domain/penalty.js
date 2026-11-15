// =====================================================================
// penalty.js: how much penalty an overdue instalment has earned by a date.
//
// D48 Rule: for every day AFTER the grace period, charge
//       (amount still overdue at the end of that day) x penalty rate / 365
//     summed over all days and rounded ONCE, half-up, to the paisa (D2).
//     "Overdue amount" is the instalment's unpaid principal + interest;
//     penalties are never charged on penalties.
//
// Pure function: it uses each payment's EFFECTIVE date, so a payment that
// arrives late still counts from the day it was really made (D50).
// =====================================================================
import { D, assertPaise, bpsToFraction, roundToPaise } from './money.js';
import { addDays, daysBetween, assertIsoDate } from './dates.js';

/**
 * @param dueDate          the instalment's due date
 * @param graceDays        penalty-free days after the due date
 * @param overdueBasePaise principal + interest due on the instalment
 * @param payments         [{ date, amountPaise }] paid towards that principal + interest
 * @param asOf             count penalty up to and including this date
 * @param penaltyRateBps   yearly penalty rate in basis points
 * @returns total penalty (paise) the instalment should carry by asOf
 */
export function penaltyThrough({ dueDate, graceDays, overdueBasePaise, payments, asOf, penaltyRateBps }) {
  assertIsoDate(dueDate);
  assertIsoDate(asOf);
  assertPaise(overdueBasePaise, 'overdueBasePaise');

  const lastFreeDay = addDays(dueDate, graceDays);
  if (asOf <= lastFreeDay) return 0;

  const sorted = [...payments].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  // Payments made on or before the last free day reduce the starting balance.
  let balance = overdueBasePaise;
  for (const p of sorted) if (p.date <= lastFreeDay) balance -= p.amountPaise;

  // Walk forward in segments. A payment made on day X counts from day X:
  // days [segmentStart, X - 1] carry the old balance, day X onwards the new one.
  let segmentStart = addDays(lastFreeDay, 1);
  let paisaDays = 0;
  for (const p of sorted) {
    if (p.date <= lastFreeDay || p.date > asOf) continue;
    paisaDays += Math.max(balance, 0) * daysBetween(segmentStart, p.date);
    balance -= p.amountPaise;
    segmentStart = p.date;
  }
  paisaDays += Math.max(balance, 0) * (daysBetween(segmentStart, asOf) + 1);

  return roundToPaise(new D(paisaDays).mul(bpsToFraction(penaltyRateBps)).div(365));
}
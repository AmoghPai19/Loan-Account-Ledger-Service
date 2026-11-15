// =====================================================================
// allocation.js: decides how a repayment is split across what is owed.
//
// D20 Order: ALL outstanding penalties first (oldest instalment first),
//     then instalment by instalment (oldest first): interest, then principal.
//     Money left after everything is paid is returned as `unallocatedPaise`
//     (the caller credits it to BORROWER_ADVANCE).
//
// Pure function: no database. Easy to test, and the same input always
// gives the same split.
// =====================================================================
import { assertPaise } from './money.js';

/**
 * @param amountPaise  the repayment, > 0
 * @param outstanding  [{ instalmentId, instalmentNo, dueDate,
 *                       penaltyPaise, interestPaise, principalPaise }]
 *                     amounts still owed on each instalment (>= 0)
 * @returns { lines: [{ instalmentId, instalmentNo, component, amountPaise }],
 *            unallocatedPaise }
 */
export function allocateRepayment(amountPaise, outstanding) {
  assertPaise(amountPaise, 'repayment amount');
  if (amountPaise <= 0) throw new RangeError('repayment amount must be positive');

  // Oldest first. Copy before sorting so the caller's array is untouched.
  const ordered = [...outstanding].sort((a, b) =>
    a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : a.instalmentNo - b.instalmentNo);

  let remaining = amountPaise;
  const lines = [];

  const take = (inst, component, owedPaise) => {
    if (remaining === 0 || owedPaise <= 0) return;
    const amount = Math.min(remaining, owedPaise);
    lines.push({ instalmentId: inst.instalmentId, instalmentNo: inst.instalmentNo, component, amountPaise: amount });
    remaining -= amount;
  };

  for (const inst of ordered) take(inst, 'PENALTY', inst.penaltyPaise);
  for (const inst of ordered) {
    take(inst, 'INTEREST', inst.interestPaise);
    take(inst, 'PRINCIPAL', inst.principalPaise);
  }

  return { lines, unallocatedPaise: remaining };
}
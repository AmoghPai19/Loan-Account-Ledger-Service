// =====================================================================
// accrual.js: the nightly job (Step 8).
//
// For every disbursed loan, as of a given date:
//   1. INTEREST: every instalment that has fallen due gets its interest
//      recognised (Dr INTEREST_RECEIVABLE / Cr INTEREST_INCOME), dated on
//      its due date, unless a repayment already recognised it (D21).
//   2. PENALTY: every instalment past its grace period is brought to the
//      penalty it SHOULD carry by that date (penaltyThrough). Only the
//      DIFFERENCE from what was already charged is posted (D49):
//        more owed  -> Dr PENALTY_RECEIVABLE / Cr PENALTY_INCOME
//        too much   -> Dr PENALTY_INCOME / Cr PENALTY_RECEIVABLE, or
//                      Cr BORROWER_ADVANCE if it was already paid (D50)
//
// Running it twice for the same date changes nothing the second time.
// One loan per database transaction, with the loan row locked (D38).
// =====================================================================
import { withTransaction } from '../db/tx.js';
import { assertIsoDate } from '../domain/dates.js';
import { penaltyThrough } from '../domain/penalty.js';
import { instalmentPositions } from '../services/loans.js';
import { LOAN_ACCOUNTS, COMPANY_ACCOUNTS, accountIds, postTransaction } from '../ledger/ledger.js';
import { recordAudit } from '../audit/audit.js';

/** Today's date in India (IST is UTC+5:30 all year round). */
export function todayInIndia(now = Date.now()) {
  return new Date(now + 330 * 60_000).toISOString().slice(0, 10);
}

/** The id of the `system` user that jobs act as (D14). */
export async function systemUserId(db) {
  const { rows } = await db.query(`SELECT id FROM users WHERE username = 'system'`);
  if (rows.length === 0) throw new Error('The system user is missing (migration 002)');
  return rows[0].id;
}

/**
 * Run the accruals for every disbursed loan (or just `loanIds`) as of `asOf`.
 * Returns totals for the run.
 */
export async function runAccruals(pool, { asOf, actorId, loanIds = null }) {
  assertIsoDate(asOf);
  const { rows } = await pool.query(
    `SELECT id FROM loans
      WHERE status = 'DISBURSED' AND disbursed_on <= $1
        AND ($2::uuid[] IS NULL OR id = ANY($2::uuid[]))
      ORDER BY id`,
    [asOf, loanIds],
  );

  const totals = {
    asOf, loansChecked: rows.length, loansChanged: 0, transactions: 0,
    interestAccruedPaise: 0, penaltyChargedPaise: 0, penaltyReversedPaise: 0, failures: [],
  };
  for (const { id } of rows) {
    try {
      const r = await accrueLoan(pool, id, asOf, actorId);
      if (r.transactions > 0) totals.loansChanged += 1;
      totals.transactions += r.transactions;
      totals.interestAccruedPaise += r.interestAccruedPaise;
      totals.penaltyChargedPaise += r.penaltyChargedPaise;
      totals.penaltyReversedPaise += r.penaltyReversedPaise;
    } catch (err) {
      // D54: one bad loan must not stop the others. Its transaction rolled
      // back, so nothing half-done remains; the next run retries it.
      totals.failures.push({ loanId: id, error: err.message });
    }
  }
  return totals;
}

/** One loan, one database transaction. */
export async function accrueLoan(pool, loanId, asOf, actorId) {
  return withTransaction(pool, async (client) => {
    const result = { transactions: 0, interestAccruedPaise: 0, penaltyChargedPaise: 0, penaltyReversedPaise: 0 };

    // Same lock as repayments (D37): the job and a repayment on the same
    // loan never interleave.
    const loan = (await client.query('SELECT * FROM loans WHERE id = $1 FOR UPDATE', [loanId])).rows[0];
    if (!loan || loan.status !== 'DISBURSED') return result; // closed since the list was read

    const positions = await instalmentPositions(client, loanId);
    const acct = await accountIds(client, loanId);
    const paymentsByInstalment = await repaymentsPerInstalment(client, loanId);
    const penaltyIncomeByInstalment = await penaltyIncomePerInstalment(client, loanId);

    for (const p of positions) {
      if (p.dueDate > asOf) continue; // not due yet

      // ---- 1. interest falls due ----
      const interestToAccrue = p.interestDuePaise - p.interestAccruedPaise;
      if (interestToAccrue > 0) {
        await postTransaction(client, {
          loanId, type: 'INTEREST_ACCRUAL', effectiveDate: p.dueDate, createdBy: actorId,
          memo: `Interest due on instalment ${p.instalmentNo}`,
          lines: [
            { accountId: acct[LOAN_ACCOUNTS.INTEREST], direction: 'DEBIT', amountPaise: interestToAccrue, instalmentId: p.instalmentId },
            { accountId: acct[COMPANY_ACCOUNTS.INTEREST_INCOME], direction: 'CREDIT', amountPaise: interestToAccrue, instalmentId: p.instalmentId },
          ],
        });
        result.transactions += 1;
        result.interestAccruedPaise += interestToAccrue;
      }

      // ---- 2. penalty: bring it to what it should be ----
      const shouldBe = penaltyThrough({
        dueDate: p.dueDate,
        graceDays: loan.grace_days,
        overdueBasePaise: p.principalDuePaise + p.interestDuePaise,
        payments: paymentsByInstalment.get(p.instalmentId) ?? [],
        asOf,
        penaltyRateBps: loan.penalty_rate_bps,
      });
      const alreadyCharged = penaltyIncomeByInstalment.get(p.instalmentId) ?? 0;
      const difference = shouldBe - alreadyCharged;

      if (difference > 0) {
        await postTransaction(client, {
          loanId, type: 'PENALTY_ACCRUAL', effectiveDate: asOf, createdBy: actorId,
          memo: `Penalty on instalment ${p.instalmentNo} up to ${asOf}`,
          lines: [
            { accountId: acct[LOAN_ACCOUNTS.PENALTY], direction: 'DEBIT', amountPaise: difference, instalmentId: p.instalmentId },
            { accountId: acct[COMPANY_ACCOUNTS.PENALTY_INCOME], direction: 'CREDIT', amountPaise: difference, instalmentId: p.instalmentId },
          ],
        });
        result.transactions += 1;
        result.penaltyChargedPaise += difference;
      } else if (difference < 0) {
        // Over-charged (a payment with an earlier date arrived late). Reduce
        // what is still owed first; anything already paid goes back to the
        // borrower as an advance (D50).
        const reversal = -difference;
        const fromReceivable = Math.min(reversal, Math.max(p.penaltyOutstandingPaise, 0));
        const toAdvance = reversal - fromReceivable;
        const lines = [
          { accountId: acct[COMPANY_ACCOUNTS.PENALTY_INCOME], direction: 'DEBIT', amountPaise: reversal, instalmentId: p.instalmentId },
        ];
        if (fromReceivable > 0) {
          lines.push({ accountId: acct[LOAN_ACCOUNTS.PENALTY], direction: 'CREDIT', amountPaise: fromReceivable, instalmentId: p.instalmentId });
        }
        if (toAdvance > 0) {
          lines.push({ accountId: acct[COMPANY_ACCOUNTS.BORROWER_ADVANCE], direction: 'CREDIT', amountPaise: toAdvance, instalmentId: p.instalmentId });
        }
        await postTransaction(client, {
          loanId, type: 'PENALTY_ACCRUAL', effectiveDate: asOf, createdBy: actorId,
          memo: `Penalty correction on instalment ${p.instalmentNo} (late-arriving payment)`,
          lines,
        });
        result.transactions += 1;
        result.penaltyReversedPaise += reversal;
      }
    }

    if (result.transactions > 0) {
      await recordAudit(client, {
        actorId, action: 'ACCRUALS_POSTED', entityType: 'loan', entityId: loanId,
        after: { asOf, ...result },
      });
    }
    return result;
  });
}

/** Repayments credited to each instalment's principal + interest, by effective date. */
async function repaymentsPerInstalment(client, loanId) {
  const { rows } = await client.query(
    `SELECT e.instalment_id, t.effective_date, SUM(e.amount_paise)::bigint AS amount
       FROM ledger_entries e
       JOIN ledger_transactions t ON t.id = e.transaction_id
       JOIN accounts a            ON a.id = e.account_id
      WHERE t.loan_id = $1 AND t.type = 'REPAYMENT'
        AND a.code IN ($2, $3) AND e.direction = 'CREDIT' AND e.instalment_id IS NOT NULL
      GROUP BY e.instalment_id, t.effective_date`,
    [loanId, LOAN_ACCOUNTS.PRINCIPAL, LOAN_ACCOUNTS.INTEREST],
  );
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.instalment_id)) map.set(r.instalment_id, []);
    map.get(r.instalment_id).push({ date: r.effective_date, amountPaise: r.amount });
  }
  return map;
}

/** Net penalty income recognised so far for each instalment (charges minus corrections). */
async function penaltyIncomePerInstalment(client, loanId) {
  const { rows } = await client.query(
    `SELECT e.instalment_id,
            SUM(CASE e.direction WHEN 'CREDIT' THEN e.amount_paise ELSE -e.amount_paise END)::bigint AS net
       FROM ledger_entries e
       JOIN accounts a             ON a.id = e.account_id
       JOIN schedule_instalments s ON s.id = e.instalment_id
      WHERE s.loan_id = $1 AND a.code = $2
      GROUP BY e.instalment_id`,
    [loanId, COMPANY_ACCOUNTS.PENALTY_INCOME],
  );
  return new Map(rows.map((r) => [r.instalment_id, r.net]));
}
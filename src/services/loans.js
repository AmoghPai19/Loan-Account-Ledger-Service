// =====================================================================
// loans.js: the business operations. Step 4's HTTP routes call these.
//
// Every operation that writes runs inside ONE database transaction
// (withTransaction), so it either fully happens or doesn't happen at all.
// `actorId` is the user doing it; it is stored on every row (and used for
// the audit trail in Step 7).
// =====================================================================
import { withTransaction } from '../db/tx.js';
import { ValidationError, NotFoundError, ConflictError } from '../errors.js';
import { assertIsoDate } from '../domain/dates.js';
import { buildSchedule, firstDueDateFor } from '../domain/schedule.js';
import { allocateRepayment } from '../domain/allocation.js';
import { requireIdempotencyKey, requestHash, claimKey, completeKey } from './idempotency.js';
import {
  LOAN_ACCOUNTS, COMPANY_ACCOUNTS, createLoanAccounts, accountIds,
  postTransaction, loanLedgerBalances,
} from '../ledger/ledger.js';

// ---------- small input checks ------------------------------------------

function requirePositivePaise(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ValidationError(`${field} must be a positive whole number of paise`);
  }
}

function requireDate(value, field) {
  try {
    return assertIsoDate(value);
  } catch {
    throw new ValidationError(`${field} must be a real date in YYYY-MM-DD format`);
  }
}

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError(`${field} is required`);
  }
  return value.trim();
}

const UNIQUE_VIOLATION = '23505'; // Postgres error code

// ---------- borrowers -----------------------------------------------------

export async function createBorrower(pool, { externalRef, fullName, phone = null }, actorId) {
  const ref = requireText(externalRef, 'externalRef');
  const name = requireText(fullName, 'fullName');
  try {
    const { rows } = await pool.query(
      `INSERT INTO borrowers (external_ref, full_name, phone, created_by)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [ref, name, phone, actorId],
    );
    return rows[0];
  } catch (err) {
    if (err.code === UNIQUE_VIOLATION) throw new ConflictError(`Borrower ${ref} already exists`);
    throw err;
  }
}

// ---------- loans -----------------------------------------------------------

export async function createLoan(pool, { borrowerId, productCode, principalPaise, tenure }, actorId) {
  requirePositivePaise(principalPaise, 'principalPaise');
  if (!Number.isInteger(tenure) || tenure <= 0) {
    throw new ValidationError('tenure must be a positive whole number of instalments');
  }

  return withTransaction(pool, async (client) => {
    const product = (await client.query(
      'SELECT * FROM loan_products WHERE code = $1 AND active', [productCode],
    )).rows[0];
    if (!product) throw new ValidationError(`Unknown or inactive product ${productCode}`);

    const borrower = (await client.query('SELECT id FROM borrowers WHERE id = $1', [borrowerId])).rows[0];
    if (!borrower) throw new NotFoundError(`Borrower ${borrowerId} not found`);

    if (principalPaise < product.min_principal_paise || principalPaise > product.max_principal_paise) {
      throw new ValidationError(
        `principal must be between ${product.min_principal_paise} and ${product.max_principal_paise} paise for ${product.code}`);
    }
    if (tenure < product.min_tenure || tenure > product.max_tenure) {
      throw new ValidationError(
        `tenure must be between ${product.min_tenure} and ${product.max_tenure} for ${product.code}`);
    }

    // D4: copy the product's terms onto the loan.
    const loan = (await client.query(
      `INSERT INTO loans (borrower_id, product_id, principal_paise, schedule_type, frequency,
                          annual_rate_bps, penalty_rate_bps, grace_days, tenure, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [borrowerId, product.id, principalPaise, product.schedule_type, product.frequency,
        product.annual_rate_bps, product.penalty_rate_bps, product.grace_days, tenure, actorId],
    )).rows[0];

    await createLoanAccounts(client, loan.id);
    return loan;
  });
}

export async function getLoan(db, loanId) {
  const loan = (await db.query('SELECT * FROM loans WHERE id = $1', [loanId])).rows[0];
  if (!loan) throw new NotFoundError(`Loan ${loanId} not found`);
  return loan;
}

/**
 * Disburse: build and store the schedule, mark the loan DISBURSED, and post
 *   Dr PRINCIPAL_RECEIVABLE (loan) / Cr BANK.
 */
export async function disburseLoan(pool, { loanId, disbursedOn }, actorId) {
  const date = requireDate(disbursedOn, 'disbursedOn');

  return withTransaction(pool, async (client) => {
    // FOR UPDATE locks this loan row until COMMIT, so two disbursement
    // requests can't both see status = CREATED and both disburse.
    const loan = (await client.query('SELECT * FROM loans WHERE id = $1 FOR UPDATE', [loanId])).rows[0];
    if (!loan) throw new NotFoundError(`Loan ${loanId} not found`);
    if (loan.status !== 'CREATED') throw new ConflictError(`Loan is already ${loan.status}`);

    const firstDueDate = firstDueDateFor(date, loan.frequency);
    const schedule = buildSchedule({
      principalPaise: loan.principal_paise,
      annualRateBps: loan.annual_rate_bps,
      tenure: loan.tenure,
      frequency: loan.frequency,
      scheduleType: loan.schedule_type,
      firstDueDate,
    });

    const params = [];
    const placeholders = schedule.map((row, k) => {
      params.push(loanId, row.instalmentNo, row.dueDate, row.principalDuePaise, row.interestDuePaise);
      const b = k * 5;
      return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5})`;
    });
    await client.query(
      `INSERT INTO schedule_instalments (loan_id, instalment_no, due_date, principal_due_paise, interest_due_paise)
       VALUES ${placeholders.join(', ')}`,
      params,
    );

    const updated = (await client.query(
      `UPDATE loans SET status = 'DISBURSED', disbursed_on = $2, first_due_date = $3
        WHERE id = $1 RETURNING *`,
      [loanId, date, firstDueDate],
    )).rows[0];

    const acct = await accountIds(client, loanId);
    const posting = await postTransaction(client, {
      loanId,
      type: 'DISBURSEMENT',
      effectiveDate: date,
      createdBy: actorId,
      memo: 'Loan disbursement',
      lines: [
        { accountId: acct[LOAN_ACCOUNTS.PRINCIPAL], direction: 'DEBIT', amountPaise: loan.principal_paise },
        { accountId: acct[COMPANY_ACCOUNTS.BANK], direction: 'CREDIT', amountPaise: loan.principal_paise },
      ],
    });

    return { loan: updated, transactionId: posting.transactionId, schedule };
  });
}

/**
 * Each instalment with what was due, and what the LEDGER says has been
 * accrued and paid against it (D9: nothing about payments is stored
 * outside the ledger).
 */
export async function instalmentPositions(db, loanId) {
  const { rows } = await db.query(
    `SELECT s.id, s.instalment_no, s.due_date, s.principal_due_paise, s.interest_due_paise,
            COALESCE(SUM(e.amount_paise) FILTER (WHERE a.code = $2 AND e.direction = 'CREDIT'), 0)::bigint AS principal_paid,
            COALESCE(SUM(e.amount_paise) FILTER (WHERE a.code = $3 AND e.direction = 'DEBIT'),  0)::bigint AS interest_accrued,
            COALESCE(SUM(e.amount_paise) FILTER (WHERE a.code = $3 AND e.direction = 'CREDIT'), 0)::bigint AS interest_paid,
            COALESCE(SUM(e.amount_paise) FILTER (WHERE a.code = $4 AND e.direction = 'DEBIT'),  0)::bigint AS penalty_accrued,
            COALESCE(SUM(e.amount_paise) FILTER (WHERE a.code = $4 AND e.direction = 'CREDIT'), 0)::bigint AS penalty_paid
       FROM schedule_instalments s
       LEFT JOIN ledger_entries e ON e.instalment_id = s.id
       LEFT JOIN accounts a       ON a.id = e.account_id
      WHERE s.loan_id = $1
      GROUP BY s.id
      ORDER BY s.instalment_no`,
    [loanId, LOAN_ACCOUNTS.PRINCIPAL, LOAN_ACCOUNTS.INTEREST, LOAN_ACCOUNTS.PENALTY],
  );
  return rows.map((r) => ({
    instalmentId: r.id,
    instalmentNo: r.instalment_no,
    dueDate: r.due_date,
    principalDuePaise: r.principal_due_paise,
    interestDuePaise: r.interest_due_paise,
    principalPaidPaise: r.principal_paid,
    interestAccruedPaise: r.interest_accrued,
    interestPaidPaise: r.interest_paid,
    penaltyAccruedPaise: r.penalty_accrued,
    penaltyPaidPaise: r.penalty_paid,
    // Still owed under the contract:
    principalOutstandingPaise: r.principal_due_paise - r.principal_paid,
    interestOutstandingPaise: r.interest_due_paise - r.interest_paid,
    penaltyOutstandingPaise: r.penalty_accrued - r.penalty_paid,
  }));
}

/** The schedule with a simple status per instalment, for the API in Step 4. */
export async function getSchedule(db, loanId) {
  const loan = await getLoan(db, loanId);
  const positions = await instalmentPositions(db, loanId);
  const instalments = positions.map((p) => {
    const owed = p.principalOutstandingPaise + p.interestOutstandingPaise + p.penaltyOutstandingPaise;
    const paid = p.principalPaidPaise + p.interestPaidPaise + p.penaltyPaidPaise;
    return { ...p, status: owed === 0 ? 'PAID' : paid > 0 ? 'PARTIALLY_PAID' : 'UNPAID' };
  });
  return { loan, instalments };
}

/**
 * Post a repayment, at most once per Idempotency-Key (Step 5).
 *
 * With a key: the key is claimed first, inside the same database
 * transaction as the posting. A repeat of the same request returns the
 * stored response with replayed: true and posts nothing.
 * Without a key (trusted internal callers only; the API always requires
 * one): the repayment is simply posted.
 */
export async function postRepayment(pool, {
  loanId, amountPaise, effectiveDate, idempotencyKey = null, externalEventId = null,
}, actorId) {
  requirePositivePaise(amountPaise, 'amountPaise');
  const date = requireDate(effectiveDate, 'effectiveDate');
  if (idempotencyKey !== null) requireIdempotencyKey(idempotencyKey);

  return withTransaction(pool, async (client) => {
    if (idempotencyKey !== null) {
      const claim = await claimKey(client, {
        key: idempotencyKey,
        userId: actorId,
        hash: requestHash(['repayment', loanId, amountPaise, date, externalEventId ?? null]),
      });
      if (!claim.claimed) return { ...claim.responseBody, replayed: true };
    }

    const result = await applyRepayment(client, {
      loanId, amountPaise, date, idempotencyKey, externalEventId, actorId,
    });

    if (idempotencyKey !== null) {
      await completeKey(client, { key: idempotencyKey, responseCode: 201, responseBody: result });
    }
    return { ...result, replayed: false };
  });
}

/**
 * The repayment itself, inside the caller's database transaction.
 *
 * 1. Work out what is owed per instalment (from the ledger).
 * 2. Split the money (allocateRepayment, D20).
 * 3. D21: if money goes to interest that hasn't been recognised yet, first
 *    post that instalment's interest (Dr INTEREST_RECEIVABLE / Cr INTEREST_INCOME).
 * 4. Post the repayment: Dr BANK, Cr each receivable it pays off,
 *    Cr BORROWER_ADVANCE for anything left over.
 * 5. Close the loan if nothing is owed any more.
 */
async function applyRepayment(client, { loanId, amountPaise, date, idempotencyKey, externalEventId, actorId }) {
  // Step 6 (D37): FOR UPDATE locks this loan row until COMMIT, so a second repayment waits here.
  const loan = (await client.query('SELECT * FROM loans WHERE id = $1 FOR UPDATE', [loanId])).rows[0];
  if (!loan) throw new NotFoundError(`Loan ${loanId} not found`);
  if (loan.status !== 'DISBURSED') throw new ConflictError(`Cannot repay a loan that is ${loan.status}`);
  if (date < loan.disbursed_on) {
    throw new ValidationError('effectiveDate cannot be before the disbursement date');
  }

  const positions = await instalmentPositions(client, loanId);
  const { lines: allocation, unallocatedPaise } = allocateRepayment(
    amountPaise,
    positions.map((p) => ({
      instalmentId: p.instalmentId,
      instalmentNo: p.instalmentNo,
      dueDate: p.dueDate,
      penaltyPaise: p.penaltyOutstandingPaise,
      interestPaise: p.interestOutstandingPaise,
      principalPaise: p.principalOutstandingPaise,
    })),
  );

  const acct = await accountIds(client, loanId);
  const accountFor = {
    PENALTY: acct[LOAN_ACCOUNTS.PENALTY],
    INTEREST: acct[LOAN_ACCOUNTS.INTEREST],
    PRINCIPAL: acct[LOAN_ACCOUNTS.PRINCIPAL],
  };

  // Step 3 (D21): recognise any not-yet-accrued interest we are about to collect.
  const byId = new Map(positions.map((p) => [p.instalmentId, p]));
  const accrualLines = [];
  let accrualTotal = 0;
  for (const line of allocation.filter((l) => l.component === 'INTEREST')) {
    const p = byId.get(line.instalmentId);
    const notYetAccrued = p.interestDuePaise - p.interestAccruedPaise;
    if (notYetAccrued > 0) {
      accrualLines.push({ accountId: accountFor.INTEREST, direction: 'DEBIT', amountPaise: notYetAccrued, instalmentId: p.instalmentId });
      accrualTotal += notYetAccrued;
    }
  }
  if (accrualTotal > 0) {
    await postTransaction(client, {
      loanId,
      type: 'INTEREST_ACCRUAL',
      effectiveDate: date,
      createdBy: actorId,
      memo: 'Interest recognised on repayment',
      lines: [
        ...accrualLines,
        { accountId: acct[COMPANY_ACCOUNTS.INTEREST_INCOME], direction: 'CREDIT', amountPaise: accrualTotal },
      ],
    });
  }

  // Step 4: the repayment itself. The idempotency key is also stored on the
  // ledger transaction, whose UNIQUE constraint is a last safety net.
  const repaymentLines = [
    { accountId: acct[COMPANY_ACCOUNTS.BANK], direction: 'DEBIT', amountPaise },
    ...allocation.map((l) => ({
      accountId: accountFor[l.component], direction: 'CREDIT', amountPaise: l.amountPaise, instalmentId: l.instalmentId,
    })),
  ];
  if (unallocatedPaise > 0) {
    repaymentLines.push({ accountId: acct[COMPANY_ACCOUNTS.BORROWER_ADVANCE], direction: 'CREDIT', amountPaise: unallocatedPaise });
  }
  const posting = await postTransaction(client, {
    loanId,
    type: 'REPAYMENT',
    effectiveDate: date,
    createdBy: actorId,
    idempotencyKey,
    externalEventId,
    memo: 'Repayment',
    lines: repaymentLines,
  });

  // Step 5: close the loan once nothing is owed.
  const allocatedTo = (id, component) => allocation
    .filter((l) => l.instalmentId === id && l.component === component)
    .reduce((s, l) => s + l.amountPaise, 0);
  const stillOwed = positions.reduce((sum, p) =>
    sum
    + (p.principalOutstandingPaise - allocatedTo(p.instalmentId, 'PRINCIPAL'))
    + (p.interestOutstandingPaise - allocatedTo(p.instalmentId, 'INTEREST'))
    + (p.penaltyOutstandingPaise - allocatedTo(p.instalmentId, 'PENALTY')), 0);

  let status = loan.status;
  if (stillOwed === 0) {
    await client.query(`UPDATE loans SET status = 'CLOSED', closed_on = $2 WHERE id = $1`, [loanId, date]);
    status = 'CLOSED';
  }

  return {
    transactionId: posting.transactionId,
    loanId,
    amountPaise,
    effectiveDate: date,
    allocation,
    advancePaise: unallocatedPaise,
    loanStatus: status,
    balances: await loanLedgerBalances(client, loanId),
  };
}
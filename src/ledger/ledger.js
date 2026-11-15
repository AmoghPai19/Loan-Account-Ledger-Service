// =====================================================================
// ledger.js: the ONLY code that writes ledger entries.
//
// Every business event becomes one ledger_transactions row (the header)
// plus two or more ledger_entries rows (the lines). Debits must equal
// credits: checked here first (clear error message, fails fast) and
// again by the database at COMMIT (D7), in case this code has a bug.
// =====================================================================
import { assertPaise } from '../domain/money.js';

/** Per-loan accounts (D5). */
export const LOAN_ACCOUNTS = Object.freeze({
  PRINCIPAL: 'PRINCIPAL_RECEIVABLE',
  INTEREST: 'INTEREST_RECEIVABLE',
  PENALTY: 'PENALTY_RECEIVABLE',
});

/** Company-wide accounts (D5), seeded by migration 002. */
export const COMPANY_ACCOUNTS = Object.freeze({
  BANK: 'BANK',
  INTEREST_INCOME: 'INTEREST_INCOME',
  PENALTY_INCOME: 'PENALTY_INCOME',
  BORROWER_ADVANCE: 'BORROWER_ADVANCE',
});

/** Creates the three receivable accounts for a new loan. */
export async function createLoanAccounts(client, loanId) {
  await client.query(
    `INSERT INTO accounts (code, type, loan_id)
     VALUES ($2, 'ASSET', $1), ($3, 'ASSET', $1), ($4, 'ASSET', $1)`,
    [loanId, LOAN_ACCOUNTS.PRINCIPAL, LOAN_ACCOUNTS.INTEREST, LOAN_ACCOUNTS.PENALTY],
  );
}

/** Returns { CODE: accountId } for the company accounts plus this loan's accounts. */
export async function accountIds(client, loanId) {
  const { rows } = await client.query(
    'SELECT id, code FROM accounts WHERE loan_id IS NULL OR loan_id = $1',
    [loanId],
  );
  return Object.fromEntries(rows.map((r) => [r.code, r.id]));
}

/**
 * Application-level balance check. Throws if the lines are not a valid
 * double-entry posting. (The database checks again at COMMIT.)
 */
export function assertBalanced(lines) {
  if (!Array.isArray(lines) || lines.length < 2) {
    throw new Error('A ledger transaction needs at least 2 lines');
  }
  let debits = 0;
  let credits = 0;
  for (const line of lines) {
    assertPaise(line.amountPaise, 'ledger line amount');
    if (line.amountPaise <= 0) throw new Error('Ledger line amounts must be positive');
    if (!line.accountId) throw new Error('Ledger line is missing accountId');
    if (line.direction === 'DEBIT') debits += line.amountPaise;
    else if (line.direction === 'CREDIT') credits += line.amountPaise;
    else throw new Error(`Unknown direction ${line.direction}`);
  }
  if (debits !== credits) {
    throw new Error(`Unbalanced ledger transaction: debits ${debits} != credits ${credits}`);
  }
  return debits;
}

/**
 * Writes one balanced ledger transaction. Must be called with a client
 * that is inside a database transaction (see withTransaction).
 *
 * lines: [{ accountId, direction: 'DEBIT'|'CREDIT', amountPaise, instalmentId? }]
 */
export async function postTransaction(client, {
  loanId = null, type, effectiveDate, createdBy, lines,
  idempotencyKey = null, externalEventId = null, memo = null,
}) {
  const totalPaise = assertBalanced(lines);

  const header = await client.query(
    `INSERT INTO ledger_transactions
       (loan_id, type, effective_date, idempotency_key, external_event_id, memo, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, posted_at`,
    [loanId, type, effectiveDate, idempotencyKey, externalEventId, memo, createdBy],
  );
  const transactionId = header.rows[0].id;

  // One multi-row INSERT for all lines: ($1,$2,$3,$4,$5), ($6,$7,...), ...
  const params = [];
  const placeholders = lines.map((line, k) => {
    params.push(transactionId, line.accountId, line.direction, line.amountPaise, line.instalmentId ?? null);
    const b = k * 5;
    return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5})`;
  });
  await client.query(
    `INSERT INTO ledger_entries (transaction_id, account_id, direction, amount_paise, instalment_id)
     VALUES ${placeholders.join(', ')}`,
    params,
  );

  return { transactionId, postedAt: header.rows[0].posted_at, totalPaise };
}

/** What the ledger says this loan owes right now, derived from entries (D6). */
export async function loanLedgerBalances(client, loanId) {
  const { rows } = await client.query(
    'SELECT code, natural_balance_paise FROM account_balances WHERE loan_id = $1',
    [loanId],
  );
  const by = Object.fromEntries(rows.map((r) => [r.code, r.natural_balance_paise]));
  const principal = by[LOAN_ACCOUNTS.PRINCIPAL] ?? 0;
  const interest = by[LOAN_ACCOUNTS.INTEREST] ?? 0;
  const penalty = by[LOAN_ACCOUNTS.PENALTY] ?? 0;
  return {
    principalReceivablePaise: principal,
    interestReceivablePaise: interest,
    penaltyReceivablePaise: penalty,
    totalReceivablePaise: principal + interest + penalty,
  };
}

/** Whole-ledger check: total debits must equal total credits. */
export async function trialBalance(client) {
  const { rows } = await client.query(
    `SELECT COALESCE(SUM(amount_paise) FILTER (WHERE direction = 'DEBIT'), 0)::bigint  AS debits,
            COALESCE(SUM(amount_paise) FILTER (WHERE direction = 'CREDIT'), 0)::bigint AS credits
       FROM ledger_entries`,
  );
  const { debits, credits } = rows[0];
  return { debitsPaise: debits, creditsPaise: credits, balanced: debits === credits };
}
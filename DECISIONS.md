# Design Decisions

Each entry: **what** was decided, the **alternatives**, and **why**. The write-up summarises this file.

## Step 0: Stack

**D0. Plain Node.js (ES modules) + PostgreSQL 16, raw SQL via `pg`, tests with Node's built-in `node:test`.**
- Alternatives: TypeScript; an ORM (Prisma, Sequelize); Jest or Vitest; SQLite or MySQL.
- Why: no build step and only two dependencies (`pg`, `decimal.js`), so every line is easy to follow.
  Raw SQL gives exact control over transactions, row locks and constraints, which ledger correctness
  depends on. Postgres offers deferred constraint triggers, `UNIQUE NULLS NOT DISTINCT` and real
  concurrent writes; SQLite can't genuinely demonstrate parallel-write safety.
- Trade-off: without TypeScript, type mistakes (e.g. rupees passed where paise were expected) are caught
  at runtime by checks such as `assertPaise()` and by tests, rather than before the code runs.

## Step 1: Data model and money

**D1. Money is stored as whole paise in `BIGINT`.**
- Alternatives: floating point; `NUMERIC(14,2)`.
- Why: floats can't represent 0.10 exactly, so errors accumulate. `NUMERIC` would work, but integers force
  every rounding decision to be explicit and testable in one module (`src/domain/money.js`).

**D2. Computed amounts are calculated at full precision (decimal.js) and rounded once, half-up, to the paisa.**
- Alternatives: banker's rounding (half-to-even); rounding intermediate steps.
- Why: half-up matches what borrowers and auditors expect when recalculating by hand. Rounding once avoids
  compounding rounding error. Banker's rounding reduces bias at very high volume; noted as an option.

**D2a. Equal splits use the integer quotient (floor), with the remainder on the last instalment.**
- Alternative: round each piece half-up.
- Why: *found while coding.* Half-up can round the first n-1 pieces up so far that the last piece goes negative
  (30 paise over 52 weeks gives a last piece of -21). Floor guarantees every piece is >= 0 and the total is exact.
  A unit test covers this case.

**D3. Rates are stored as integer basis points (2400 = 24.00%).**
- Why: the same reasoning as D1. No floats anywhere in stored data.

**D4. Product terms are copied (snapshotted) onto each loan when it is created.**
- Alternative: look up rates from the product at calculation time.
- Why: a product is a template. Repricing it must never change existing contracts.

**D5. Each loan gets its own receivable accounts; a few accounts are company-wide.**
- Per loan: PRINCIPAL_RECEIVABLE, INTEREST_RECEIVABLE, PENALTY_RECEIVABLE.
- Company-wide: BANK, INTEREST_INCOME, PENALTY_INCOME, BORROWER_ADVANCE (a liability, for overpayments).
- Alternative: a single receivable account, with a loan_id tag on each entry.
- Why: "what does this loan owe?" becomes a direct balance query, and the chart of accounts stays a real ledger.

**D6. The ledger is append-only, and balances are always derived, never stored.**
- Corrections are posted as REVERSAL transactions. Triggers forbid UPDATE and DELETE on ledger and audit tables.
  The `account_balances` view computes debits - credits.
- Trade-off: summing entries gets slower as they grow. At scale I'd add periodic balance snapshots
  (a "with more time" item).

**D7. Debits = credits is enforced by the database, not just the application.**
- How: a `DEFERRABLE INITIALLY DEFERRED` constraint trigger that checks each transaction at COMMIT; it also
  rejects transactions with fewer than 2 lines. Amounts must be > 0, and the direction column carries the sign.
- Why: a bug in application code can't write an unbalanced ledger. Defence in depth.

**D8. Every transaction has two dates: `effective_date` (when it happened) and `posted_at` (when it was recorded).**
- Why: this is how out-of-order events are handled. A payment made on 3 March that arrives on 10 March is
  still treated as 3 March.

**D9. The schedule stores what is due, never what is paid.**
- "Paid" per instalment is the sum of ledger entries tagged with `instalment_id`. This keeps D6 intact.

**D10. Repayments are allocated penalty -> interest -> principal, oldest instalment first.** *(implemented in Step 3)*

**D11. Interest is recognised on each instalment's due date; penalty accrues daily on overdue amounts.** *(Step 8)*
- Alternative: daily interest accrual. More precise, but far more entries; noted as a trade-off.

**D12. In JavaScript, paise are ordinary `number` values guarded by `Number.isSafeInteger`, not `BigInt`.**
- Why: exact up to 2^53-1 paise (about Rs.90 lakh crore), far beyond any loan. They also work naturally with JSON,
  which `BigInt` does not. The `pg` type parser throws if a database value would ever lose precision.

**D13. Dates (`DATE`) are kept as `'YYYY-MM-DD'` strings in JavaScript, never `Date` objects.**
- Why: by default node-postgres turns a DATE into local midnight, which can shift a due date by a day
  depending on the server's timezone (IST is UTC+5:30). Due dates must never move.

**D14. Staff authenticate with API keys stored only as SHA-256 hashes; scheduled jobs act as a `system` user.**
- Why: simple and sufficient for the exercise, and every ledger row and audit row still has a real actor.
  A production system would use SSO/OAuth.

**D15. The Docker database is exposed on host port 5433, not the default 5432.**
- Why: a locally installed PostgreSQL already used 5432. Mapping 5433->5432 avoids the clash
  without changing the container itself. All connection settings come from `.env`.

## Step 2: Schedule engine

**D16. Due dates are anchored to the first due date, with month-end clamping.**
- Instalment k is due `first due date + k periods`, never `previous due date + 1 period`.
- Alternative: chaining from the previous instalment. It drifts: 31 Jan -> 28 Feb -> 28 Mar -> 28 Apr ...
  Anchoring gives 31 Jan -> 28 Feb -> 31 Mar -> 30 Apr, which is what the contract means.
- The first instalment is due one period after disbursement (7 days, or 1 calendar month).

**D17. Periodic rate = annual rate / periods per year (12 or 52), not actual days / 365.**
- Alternative: day-count conventions (actual/365), where each period's interest depends on its exact length.
- Why: this is the standard EMI convention, every instalment is predictable, and results match the
  spreadsheet PMT function, so anyone can verify them. Day-count precision is used for penalties
  (Step 8), where amounts depend on exactly how many days a payment is late.

**D18. Reducing-balance: EMI is rounded half-up to the paisa; the last instalment repays exactly the
remaining principal.**
- Consequence: the final instalment may differ from the EMI by a few paise (Rs.9,167.99 instead of
  Rs.9,168.00 in the test example). This is visible and explainable, and the loan always closes at exactly 0.
- Alternative: rounding the EMI up to the whole rupee (common in practice), which leaves a larger final
  adjustment. Rounding to the paisa keeps the maths closest to the formula.

**D19. The schedule engine is pure functions (no database, no clock).**
- Why: it can be tested in isolation against hand-calculated values. A property test checks 600 loan
  combinations for the rules that must always hold: principal sums exactly, no negative amounts,
  the balance ends at zero, and due dates increase.
- Expected test values were computed independently (Python Decimal, cross-checked with PMT) rather than
  copied from the code's own output.
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

## Step 3: Ledger posting service

**D20. Repayment allocation order: all penalties first (oldest instalment first), then instalment by
instalment, oldest first: interest, then principal.**
- Alternative: component-first across all instalments (all interest everywhere, then all principal).
- Why: clears the costliest and oldest dues first, which is standard lending practice, and an instalment is
  fully settled before money moves to the next. It is a pure function (`allocateRepayment`) with its own unit tests.

**D21. Interest becomes receivable when its instalment falls due (accrual job, Step 8), OR earlier when a
repayment reaches it, whichever happens first.**
- How: before crediting interest that hasn't been accrued yet, the repayment posts that instalment's full
  interest as an INTEREST_ACCRUAL (Dr INTEREST_RECEIVABLE / Cr INTEREST_INCOME), in the same database transaction.
- Why: the Interest Receivable account can never go negative (you can't collect what was never owed),
  and the accrual job won't recognise the same interest twice, because "already accrued" is derived from the ledger.

**D22. Money beyond what is currently due pays future instalments in order (schedule unchanged); only money
beyond the whole loan goes to BORROWER_ADVANCE.**
- Alternative: treat excess as a principal prepayment and recalculate the schedule (lower future interest).
- Why: simple and common in microfinance ("paying instalments in advance"). Trade-off: a borrower who
  pre-pays still pays the scheduled interest; prepayment rebates / rescheduling are a "with more time" item.

**D23. Every write is one database transaction, and the posting code checks balance before writing.**
- `withTransaction` wraps each operation: a repayment's accrual, entries and loan-status change all commit
  together or not at all. `assertBalanced` gives a clear error early; the database trigger (D7) remains the
  final guarantee. A test confirms that rejected requests leave nothing behind in the ledger.

**D24. The service layer throws typed errors (ValidationError 400, NotFoundError 404, ConflictError 409).**
- Why: business rules stay independent of HTTP. Step 4 maps each type to a status code in one place.

**D25. Disbursement locks the loan row (`SELECT ... FOR UPDATE`) before checking its status.**
- Why: two simultaneous disburse requests could otherwise both see CREATED and both disburse.
  The same protection for repayments is deliberately left to Step 6, where a parallel test proves it is needed.

## Step 4: REST API

**D26. Express 5 for routing; routes are thin and call the service layer.**
- Alternatives: plain `node:http` (no dependency, but hand-written URL and JSON parsing); Fastify.
- Why: readable routes, and Express 5 forwards errors thrown in `async` handlers to the error handler
  automatically, so routes need no try/catch. All business rules stay in `src/services` and are tested
  without HTTP. `createApp()` is separate from `server.js`, so tests start the app on a random free port.

**D27. Money crosses the API as integer paise, in fields ending in `Paise` (e.g. `amountPaise: 93333`).**
- Alternative: decimal rupee strings ("933.33").
- Why: identical to how it is stored, so there is no parsing or rounding at the boundary, and the field
  name makes the unit impossible to miss. Clients format for display (`formatPaise` shows how).

**D28. Every request (except /health) must send `X-API-Key`; the key's SHA-256 hash identifies the user.**
- Missing or unknown key returns 401. The user becomes the actor on every row written.
  Step 7 adds role checks (what each user may do) on top of this.

**D29. One error format and one error handler: `{ "error": { "code", "message", "details" } }`.**
- ValidationError -> 400, unknown key -> 401, NotFoundError -> 404, ConflictError -> 409, malformed JSON -> 400.
- Unexpected errors are logged on the server and return a generic 500, never internal details.
- A malformed id (not a UUID) returns 404 rather than reaching Postgres and causing a 500.

**D30. The database uses snake_case; the API uses camelCase, converted at the edge (`toCamel`).**
- Why: each side follows its own convention, and the conversion happens in one place.

## Step 5: Idempotency

**D31. Every repayment request must carry a client-generated `Idempotency-Key` header, reused on retries.**
- A repeat with the same key returns the original status and body, marked `"replayed": true` and with an
  `Idempotent-Replayed: true` header, and posts nothing.
- Alternative: the server detects duplicates itself (same loan, amount and date within a time window).
- Why not: two genuine, identical payments (e.g. two EMIs of the same amount on the same day) would be
  wrongly merged. Only the client knows whether a request is a retry or a new payment.

**D32. The key is claimed inside the SAME database transaction as the ledger posting.**
- Claim (INSERT into `idempotency_records`), post the entries, store the response: one COMMIT.
- Consequences: there is never a saved key without its posting, or a posting without its key. A request that
  fails (bad date, closed loan) rolls the key back too, so the client can fix the request and retry.
- Alternative: a separate store (e.g. Redis) with an IN_PROGRESS state, which then needs timeouts and recovery
  for requests that crashed halfway.

**D33. Duplicates that arrive at the same moment are serialised by Postgres itself.**
- `INSERT ... ON CONFLICT (key) DO NOTHING`: a second INSERT of a key that another open transaction has just
  inserted WAITS for that transaction to finish, then sees the key and replays. No extra locks are needed.
- Proven by a test that fires 5 identical requests in parallel: exactly one posts (run 10 times, passing every time).
- Last safety net: `ledger_transactions.idempotency_key` is also UNIQUE.

**D34. The same key with a different request (or from a different user) is rejected with 422.**
- A SHA-256 fingerprint of (loan, amount, effective date, external event id) is stored with the key.
- Why: reusing a key for a different payment is a client bug; silently returning the old response would hide it.

**D35. The service accepts requests without a key (trusted internal callers); the HTTP API always requires one.**

**D36. Keys are kept indefinitely.**
- Fine at this scale. With more time: expire keys after e.g. 30 days with a scheduled cleanup, as payment APIs do.

## Step 6: Concurrency

**D37. Every repayment locks its loan row (`SELECT ... FOR UPDATE`) before reading what is owed.**
- A second repayment on the same loan waits at that line until the first commits. Under Postgres's default
  READ COMMITTED isolation, each later statement sees newly committed data, so the waiting repayment then
  reads the position AFTER the first payment and allocates correctly.
- Why the loan row: the loan is the unit that must stay consistent. Payments on DIFFERENT loans lock
  different rows and never wait for each other.
- Alternatives: SERIALIZABLE isolation (correct, but every conflict aborts a transaction that must be retried);
  optimistic locking with a version column (also needs retries); a per-loan queue (more infrastructure).
  A row lock is the simplest correct option for short transactions like these.

**D38. No deadlocks by design: a repayment takes its idempotency key, then exactly ONE loan lock.**
- A transaction never locks two loans, so two transactions can't each hold a lock the other needs.
  The accrual job (Step 8) follows the same rule: one loan per transaction.

**D39. The concurrency test compares parallel results with the sequential result.**
- Allocation is a waterfall (D20), so N payments posted one after another end exactly where ONE payment of
  their total would. `allocateRepayment(total)` therefore gives the expected position of every instalment.
- Shown failing WITHOUT the lock:
  - 10 parallel EMIs: instalment 1's interest was paid Rs.15,000 against Rs.1,500 due (all ten payments
    read "instalment 1 unpaid" and paid it).
  - 25 parallel payments of different amounts: Rs.24,772.11 of interest credited to instalment 1 against Rs.1,500 due.
  - 15 parallel EMIs (Rs.1,37,520 against Rs.1,10,015.99 owed): the loan never closed.
  - Throughout, the trial balance still balanced: every corrupted transaction had debits = credits.
    "The ledger balances" alone does not prove the money landed in the right place.
- Passing WITH the lock, on every run, for all three scenarios.

**D40. Status checks happen under the lock.**
- When parallel payments overpay a loan, exactly one of them closes it; the rest see CLOSED and are refused
  with 409, posting nothing. Accepted money minus the borrower advance equals exactly what was owed.

## Step 7: Roles and audit trail

**D41. Permissions live in one table (`src/http/authorize.js`); every route declares the permission it needs.**
- A caller whose role lacks it gets 403 FORBIDDEN, before any business logic runs.
- Alternatives: role checks scattered through routes or services.
- Why: one place to read and review the whole policy. The table is unit-tested, and an HTTP test calls
  every endpoint with every role (10 endpoints x 3 roles) to check the routes really use it.

**D42. Maker-checker: officers create loans, but only managers can disburse.**
- Why: disbursement is when money leaves the bank, so one person alone can't create and pay out a fake loan.
- With more time: also stop a manager disbursing a loan they created themselves.

**D43. Auditors are strictly read-only; officers can't see the company-wide trial balance or the audit trail.**

**D44. Every change writes an audit row INSIDE the same database transaction as the change.**
- Rows record the actor, action, entity, time, and a JSON snapshot of before and after.
- Actions: BORROWER_CREATED, LOAN_CREATED, LOAN_DISBURSED, REPAYMENT_POSTED, LOAN_CLOSED.
- Repayments and closure are filed under the loan, so a loan's complete history is one query:
  `GET /audit?entityType=loan&entityId=<id>`.
- Why the same transaction: there can never be a change without its audit row, or an audit row for a
  change that was rolled back. The table is append-only (trigger from Step 1), and a test proves that
  UPDATE and DELETE are rejected even directly in the database.

**D45. Only real changes are audited.**
- Idempotent replays, failed requests and forbidden requests change nothing, so they write no audit row.
- With more time: a separate security log of denied (403) attempts.

**D46. Every request gets an id (`X-Request-Id`): taken from the caller if sensible, otherwise generated.**
- It is returned on every response and stored on every audit row the request causes, so a support
  ticket quoting a request id leads straight to the exact changes it made.

**D47. Authorisation is enforced at the API boundary; services trust their callers.**
- Internal callers (the accrual job, the replay) call services directly as the `system` user.
- Trade-off: a new entry point must remember to check permissions. With more time: pass the user's role
  into the services and check there too (defence in depth).

## Step 8: Accrual job (interest and penalties)

**D48. Penalty: for each day AFTER the grace period, (overdue principal + interest) x penalty rate / 365.**
- Summed over all days in exact integers and rounded once, half-up, to the paisa (D2). No penalty on penalty.
- Grace means grace: an instalment paid within its grace days pays no penalty, and days inside the grace
  period are never charged, even if payment comes later.
- Day count is actual/365, because a penalty depends on exactly how many days a payment is late (see D17).
- Alternatives: a flat late fee; charging from the due date once grace is exceeded; compounding.
- Verified against an independent day-by-day Python calculation; the code uses a faster segment method.

**D49. The job is idempotent: it computes what the penalty SHOULD be by the run date, and posts only the difference.**
- Running twice for the same date posts nothing the second time (tested). A missed night needs no special
  handling: the next run computes "up to today" and catches up.
- "Already charged" is derived from the ledger (PENALTY_INCOME lines tagged with the instalment), so no
  extra state table is needed (consistent with D6).

**D50. Out-of-order payments: penalties use each payment's EFFECTIVE date, so late arrivals self-correct.**
- Example (tested): the job charged 10 days (Rs.60.28); then a payment dated 2026-02-25 arrived. The next run
  recalculated with the real date (Rs.24.35) and reversed the Rs.35.93 difference.
- A reversal first reduces penalty still owed; any part already paid is credited to BORROWER_ADVANCE
  (money owed back to the borrower).
- With more time: apply borrower advances to the next dues automatically.

**D51. Interest recognised by the job is dated on the instalment's due date, whatever day the job runs.**

**D52. Scheduling: an in-process daily timer (`ACCRUAL_DAILY_AT=01:00`, India time) plus `npm run accrue`.**
- The CLI command suits cron or Windows Task Scheduler; `--as-of YYYY-MM-DD` re-runs any date.
- Trade-off: with several API instances, each timer would run the job. That is safe (D49 plus the loan
  lock) but wasteful. In production I'd run one scheduler (e.g. a cron job) or elect a leader with a
  Postgres advisory lock.

**D53. One loan per database transaction, with the loan row locked, exactly like repayments (D37, D38).**
- The job and a repayment on the same loan never interleave; a test runs the job twice in parallel and
  shows exactly one of them does the work.

**D54. One failing loan does not stop the run.**
- Its transaction rolls back (nothing half-written), the failure is listed in the run's totals,
  and the next run retries it.

## Step 9: Synthetic data and the 5,000-event replay

**D55. The generator is seeded (mulberry32), so the same seed always produces the same dataset.**
- `npm run generate` (seed 20260101) gives 220 borrowers, 261 loans (130 weekly group, 68 EMI, 63 flat-rate)
  and exactly 5,000 events. A test checks that generating twice gives identical data.

**D56. Borrowers behave realistically, and all personal data is invented.**
- Per instalment: 70% pay on time, 12% pay 3-25 days late, 6% split the payment in two, 4% miss it and
  catch up with the next one, 4% round up to the next Rs.100, 4% pay a few days early.
- Names are random combinations from short lists; phone numbers use the prefix +91-00000-, which is not a real number range.

**D57. Two delivery problems are added on purpose.**
- 300 duplicate deliveries of existing event ids: 40% arrive seconds later (a quick gateway retry),
  60% minutes to 3 days later (a webhook redelivered).
- 8% of payments are delayed 3-30 days in transit, so they arrive after later payments by the same borrower.

**D58. Each event's id is used as its Idempotency-Key and stored as external_event_id.**
- Duplicates are therefore caught by exactly the same mechanism as API retries (Step 5): no special replay logic.

**D59. The replay feeds events in ARRIVAL order on a simulated clock, with the accrual job every 7 simulated days.**
- Payments post at their real (effective) dates. Because the job computes "what is owed by today" (D49),
  running it weekly instead of nightly keeps the replay to about 1.5 minutes.
- Each replay uses a fresh `ledger_replay` database, so development data is never touched.

**D60. Different loans are processed in parallel (8 at a time); each loan's own events go one by one, in arrival order.**
- Found while building it: processing same-loan, same-day payments in parallel let the lock pick either one
  first. Both orders are correct, but they split money between penalty and principal differently, so penalty
  income varied by a few paise between runs. One-by-one per loan makes the report identical on every run.
  Safety under same-loan races is already proven by the Step 5 and Step 6 tests.

**D61. How events are classified and counted.**
- Duplicate: an event id that has already arrived. Out-of-order: a first arrival whose payment date is earlier
  than a payment for the same loan that already arrived.
- Duplicates are counted PER EVENT ID: each id must post at most once, and every extra copy must be answered
  without posting. Found while building it: my first report counted "was the LATER copy replayed?", which
  failed 25 times because copies arriving seconds apart raced and either copy could win. The ledger was
  correct; the report was asking the wrong question.

**D62. Replay results (seed 20260101): PASS.**
- 5,000 events: 4,700 posted (one per unique event id), 300 duplicates answered without posting, 0 posted twice,
  267 out-of-order arrivals all posted at their real dates, 0 failures.
- Trial balance balances (Rs.4,17,92,697.05 on each side); every transaction balances; all accounts net to zero;
  money into the bank equals the sum of posted events exactly; no instalment overpaid; no negative receivables.
- Late-arriving payments triggered Rs.3,754.98 of penalty reversals. All of it had already been paid, so it
  now sits in BORROWER_ADVANCE (owed back to borrowers), which matches D50 exactly.
- Only 2 of 261 loans closed: the payment data runs to September, while most loans run longer.
**D63. Replay runtime: about 1.5 minutes on Linux, about 61 minutes on Windows with Docker Desktop; identical results.**
- Likely cause: each weekly accrual run opens one locked transaction per loan, even for loans with nothing due
  (about 10,000 mostly empty transactions over the replay, plus 4,700 repayments), and committing is slow
  when the database's disk sits inside Docker Desktop's virtual machine.
- With more time: select only the loans that have something to accrue in one query before opening any
  transactions, and measure commit latency to confirm the cause.
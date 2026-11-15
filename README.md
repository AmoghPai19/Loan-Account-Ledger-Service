# Loan Account Ledger Service

A REST service for borrowers, loans, repayment schedules and repayments, recorded in a
**double-entry ledger**. Built with plain **Node.js** (ES modules), **Express 5** and **PostgreSQL 16**.

- Money is stored as **whole paise** (integers), rates as **basis points**; rounding is half-up, once.
- Flat-rate and reducing-balance (EMI) schedules, weekly or monthly.
- Every transaction balances, and **the database enforces it**; balances are derived from entries.
- Repayments are **idempotent** (Idempotency-Key) and **concurrency-safe** (row lock per loan).
- **Roles** (loan officer, manager, auditor) and an append-only **audit trail**.
- A scheduled **accrual job** for interest and penalties, which corrects itself for late-arriving payments.
- A **5,000-event replay** of synthetic data with duplicates and out-of-order arrivals: **PASS**.

## Documents

| | |
|---|---|
| [docs/Loan-Ledger-Writeup.pdf](docs/Loan-Ledger-Writeup.pdf) | The write-up: design, idempotency and concurrency, replay results, decisions, learnings |
| [DECISIONS.md](DECISIONS.md) | Every design decision (D0-D63): what, the alternatives, and why |
| [reports/replay-report.md](reports/replay-report.md) | Results of the 5,000-event replay |
| [docs/openapi.yaml](docs/openapi.yaml) | OpenAPI 3.0 specification of every endpoint |
| [postman/Loan-Ledger.postman_collection.json](postman/Loan-Ledger.postman_collection.json) | Postman collection: the full loan life cycle, with built-in checks |

## Quick start

Needs **Node.js 20.12+** and **Docker**.

```bash
docker compose up -d     # PostgreSQL 16 on port 5433; creates `ledger` and `ledger_test`
npm install
cp .env.example .env     # Windows PowerShell: Copy-Item .env.example .env
npm run migrate          # creates the tables and reference data
npm test                 # 138 tests
npm start                # API on http://localhost:3000
```

## Commands

| Command | What it does |
|---|---|
| `npm start` | Start the API on port 3000 (`PORT` to change) |
| `npm test` | Run all unit and integration tests (uses the separate `ledger_test` database) |
| `npm run migrate` | Apply `migrations/*.sql` |
| `npm run accrue -- --as-of 2026-03-31` | Run the accrual job once (default: today, India time) |
| `npm run generate` | Generate the synthetic dataset into `data/synthetic-dataset.json` (seeded: always the same) |
| `npm run replay` | Replay the 5,000 events into a fresh `ledger_replay` database and write `reports/replay-report.*` |

To run the accrual job every night inside the API, add `ACCRUAL_DAILY_AT=01:00` (India time) to `.env`.

The replay takes about 1.5 minutes on Linux and can take around an hour on Windows with Docker Desktop
(same results; see D63 in DECISIONS.md). It prints progress once per simulated month.

## Using the API

Send an API key in the `X-API-Key` header. Development keys (local only):

| Key | User | Role | May |
|---|---|---|---|
| `dev-officer-key` | officer.asha | OFFICER | view; create borrowers and loans; post repayments |
| `dev-manager-key` | manager.ravi | MANAGER | everything an officer can, plus **disburse**, trial balance, audit trail |
| `dev-auditor-key` | auditor.meera | AUDITOR | view everything, including trial balance and audit trail; change nothing |

| Method and path | Purpose |
|---|---|
| `GET /health` | Health check (no key) |
| `GET /me` | The user behind the key |
| `GET /products` | Loan products |
| `POST /borrowers`, `GET /borrowers/:id` | Create / view a borrower |
| `POST /loans`, `GET /loans/:id` | Create / view a loan (with ledger-derived balances) |
| `POST /loans/:id/disburse` | Disburse (manager only) |
| `GET /loans/:id/schedule` | Repayment schedule, with paid and outstanding amounts |
| `POST /loans/:id/repayments` | Post a repayment; requires an `Idempotency-Key` header |
| `GET /ledger/trial-balance` | Total debits and credits |
| `GET /audit?entityType=loan&entityId=:id` | Audit trail, newest first |

**Money is in paise:** `"amountPaise": 916800` is Rs.9,168.00. Dates are `YYYY-MM-DD`.
Errors always look like `{ "error": { "code": "...", "message": "..." } }`.

**Postman:** import the collection, start the API, then *Run collection*. It creates a borrower and a loan,
shows an officer being refused disbursement, disburses as a manager, posts a repayment, retries it (replayed,
not posted twice), and checks the trial balance and audit trail.

## Products

| Code | Product | Schedule | Rate | Penalty | Grace | Amount | Tenure |
|---|---|---|---|---|---|---|---|
| WGL | Weekly Group Loan | reducing balance, weekly | 24% p.a. | 36% p.a. | 2 days | Rs.5,000 - Rs.50,000 | 25-52 weeks |
| EMI | Monthly EMI Loan | reducing balance, monthly | 18% p.a. | 24% p.a. | 5 days | Rs.20,000 - Rs.5,00,000 | 6-36 months |
| FLT | Flat-Rate Loan | flat, monthly | 12% p.a. flat | 24% p.a. | 5 days | Rs.10,000 - Rs.2,00,000 | 6-24 months |

## Project layout

| Path | Contents |
|---|---|
| `migrations/` | SQL schema, ledger triggers, reference data |
| `src/domain/` | Pure business logic: money, dates, schedules, allocation, penalties |
| `src/ledger/` | The only code that writes ledger entries |
| `src/services/` | Borrowers, loans, repayments, idempotency |
| `src/audit/` | Audit trail |
| `src/jobs/` | Accrual job and daily scheduler |
| `src/http/`, `src/app.js` | Authentication, role permissions, routes, error handling |
| `scripts/` | Migrations, accrual CLI, data generator, replay |
| `tests/unit/`, `tests/integration/` | 138 tests (Node's built-in test runner) |

## Tests

`npm test` runs 138 tests, including:

- **Ledger balance:** the database rejects unbalanced or edited transactions; every scenario checks the trial balance.
- **Idempotency:** the same request sent twice, retried after a timeout, or sent 5 times at once posts once.
- **Concurrency:** 10, 25 and 15 parallel repayments over HTTP leave exactly the sequential result.
- **Schedules:** EMI and flat-rate values checked against independent calculations, plus 600 generated loans.
- **Roles and audit:** every endpoint with every role; audit rows for every change, none for failed requests.
- **Accruals:** penalties match a day-by-day calculation; re-running changes nothing; late payments are corrected.
- **Replay:** a 400-event replay with duplicates and out-of-order arrivals passes every check.

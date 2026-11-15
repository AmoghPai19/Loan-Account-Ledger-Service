# Loan Account Ledger Service

Plain Node.js (ES modules) + PostgreSQL 16. Tests use Node's built-in test runner.

## Quick start
```bash
docker compose up -d          # Postgres 16 on host port 5433, creates `ledger` and `ledger_test`
npm install
cp .env.example .env          # scripts read DATABASE_URL from .env
npm run migrate               # applies migrations/*.sql
npm test                      # unit + integration tests (uses ledger_test)
```

## Layout
| Path | What |
|---|---|
| `migrations/` | SQL schema and seed data |
| `src/db/` | connection pool and type parsers |
| `src/domain/` | pure business logic (money, dates, schedules) |
| `scripts/` | migration runner (later: data generator, replay) |
| `tests/` | unit and integration tests |
| `DECISIONS.md` | design decision log |

## Dev API keys (local only)
`dev-officer-key`, `dev-manager-key`, `dev-auditor-key`
// =====================================================================
// app.js: the HTTP API. Each route is thin: read the request, call a
// service function, send the result. All business rules live in
// src/services, so they are tested without HTTP too.
//
// createApp() returns the Express app WITHOUT starting a server, so tests
// can start it on a random free port (see tests/integration/api.test.js).
// =====================================================================
import express from 'express';
import { authenticate } from './http/auth.js';
import { AppError, NotFoundError } from './errors.js';
import {
  createBorrower, createLoan, getLoan, disburseLoan, getSchedule, postRepayment,
} from './services/loans.js';
import { loanLedgerBalances, trialBalance } from './ledger/ledger.js';

// ---------- helpers ---------------------------------------------------------

/** Database rows use snake_case; the API uses camelCase. */
function toCamel(row) {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), value]),
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A malformed id can't match anything, so answer 404 instead of letting Postgres fail. */
function requireUuid(value, what) {
  if (!UUID.test(value)) throw new NotFoundError(`${what} ${value} not found`);
  return value;
}

// ---------- the app ---------------------------------------------------------

export function createApp({ pool }) {
  const app = express();
  app.use(express.json({ limit: '100kb' }));

  // Unauthenticated health check, for load balancers and quick manual tests.
  app.get('/health', async (req, res) => {
    await pool.query('SELECT 1');
    res.json({ status: 'ok' });
  });

  // Everything below needs a valid API key.
  app.use(authenticate(pool));

  // ----- products -----
  app.get('/products', async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM loan_products WHERE active ORDER BY code');
    res.json(rows.map(toCamel));
  });

  // ----- borrowers -----
  app.post('/borrowers', async (req, res) => {
    const { externalRef, fullName, phone } = req.body ?? {};
    const borrower = await createBorrower(pool, { externalRef, fullName, phone }, req.user.id);
    res.status(201).json(toCamel(borrower));
  });

  app.get('/borrowers/:id', async (req, res) => {
    const id = requireUuid(req.params.id, 'Borrower');
    const { rows } = await pool.query('SELECT * FROM borrowers WHERE id = $1', [id]);
    if (rows.length === 0) throw new NotFoundError(`Borrower ${id} not found`);
    res.json(toCamel(rows[0]));
  });

  // ----- loans -----
  app.post('/loans', async (req, res) => {
    const { borrowerId, productCode, principalPaise, tenure } = req.body ?? {};
    const loan = await createLoan(pool, { borrowerId, productCode, principalPaise, tenure }, req.user.id);
    res.status(201).json(toCamel(loan));
  });

  app.get('/loans/:id', async (req, res) => {
    const id = requireUuid(req.params.id, 'Loan');
    const loan = await getLoan(pool, id);
    res.json({ ...toCamel(loan), balances: await loanLedgerBalances(pool, id) });
  });

  app.post('/loans/:id/disburse', async (req, res) => {
    const id = requireUuid(req.params.id, 'Loan');
    const { disbursedOn } = req.body ?? {};
    const result = await disburseLoan(pool, { loanId: id, disbursedOn }, req.user.id);
    res.json({
      loan: toCamel(result.loan),
      transactionId: result.transactionId,
      instalments: result.schedule.length,
    });
  });

  app.get('/loans/:id/schedule', async (req, res) => {
    const id = requireUuid(req.params.id, 'Loan');
    const { loan, instalments } = await getSchedule(pool, id);
    const sum = (field) => instalments.reduce((s, i) => s + i[field], 0);
    res.json({
      loanId: loan.id,
      status: loan.status,
      scheduleType: loan.schedule_type,
      frequency: loan.frequency,
      instalments,
      totals: {
        principalDuePaise: sum('principalDuePaise'),
        interestDuePaise: sum('interestDuePaise'),
        principalPaidPaise: sum('principalPaidPaise'),
        interestPaidPaise: sum('interestPaidPaise'),
        penaltyPaidPaise: sum('penaltyPaidPaise'),
        outstandingPaise: sum('principalOutstandingPaise') + sum('interestOutstandingPaise') + sum('penaltyOutstandingPaise'),
      },
    });
  });

  app.post('/loans/:id/repayments', async (req, res) => {
    const id = requireUuid(req.params.id, 'Loan');
    const { amountPaise, effectiveDate, externalEventId } = req.body ?? {};
    const result = await postRepayment(pool, { loanId: id, amountPaise, effectiveDate, externalEventId }, req.user.id);
    res.status(201).json(result);
  });

  // ----- ledger -----
  app.get('/ledger/trial-balance', async (req, res) => {
    res.json(await trialBalance(pool));
  });

  // ----- unknown routes -----
  app.use((req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${req.path}` } });
  });

  // ----- errors (Express 5 sends errors from async handlers here automatically) -----
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof AppError) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON' } });
    }
    console.error(err);   // unexpected: log it, but never leak internals to the client
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } });
  });

  return app;
}
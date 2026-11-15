// =====================================================================
// app.js: the HTTP API. Each route is thin: read the request, call a
// service function, send the result. All business rules live in
// src/services, so they are tested without HTTP too.
//
// createApp() returns the Express app WITHOUT starting a server, so tests
// can start it on a random free port (see tests/integration/api.test.js).
//
// Step 7: every route names the permission it needs (D41), and every
// request gets an id that is stored on the audit rows it causes (D46).
// =====================================================================
import { randomUUID } from 'node:crypto';
import express from 'express';
import { authenticate } from './http/auth.js';
import { requirePermission } from './http/authorize.js';
import { listAudit } from './audit/audit.js';
import { AppError, NotFoundError, ValidationError } from './errors.js';
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

  // D46: a request id for tracing. Use the caller's X-Request-Id if it is a
  // sensible value, otherwise make one. It is echoed back on every response.
  app.use((req, res, next) => {
    const incoming = req.get('X-Request-Id');
    req.id = incoming && /^[\x21-\x7E]{1,100}$/.test(incoming) ? incoming : randomUUID();
    res.set('X-Request-Id', req.id);
    next();
  });
  const meta = (req) => ({ requestId: req.id });

  // Unauthenticated health check, for load balancers and quick manual tests.
  app.get('/health', async (req, res) => {
    await pool.query('SELECT 1');
    res.json({ status: 'ok' });
  });

  // Everything below needs a valid API key.
  app.use(authenticate(pool));

  // Who am I? Handy for checking a key and its role.
  app.get('/me', requirePermission('read'), (req, res) => {
    res.json({ id: req.user.id, username: req.user.username, role: req.user.role });
  });

  // ----- products -----
  app.get('/products', requirePermission('read'), async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM loan_products WHERE active ORDER BY code');
    res.json(rows.map(toCamel));
  });

  // ----- borrowers -----
  app.post('/borrowers', requirePermission('borrower:create'), async (req, res) => {
    const { externalRef, fullName, phone } = req.body ?? {};
    const borrower = await createBorrower(pool, { externalRef, fullName, phone }, req.user.id, meta(req));
    res.status(201).json(toCamel(borrower));
  });

  app.get('/borrowers/:id', requirePermission('read'), async (req, res) => {
    const id = requireUuid(req.params.id, 'Borrower');
    const { rows } = await pool.query('SELECT * FROM borrowers WHERE id = $1', [id]);
    if (rows.length === 0) throw new NotFoundError(`Borrower ${id} not found`);
    res.json(toCamel(rows[0]));
  });

  // ----- loans -----
  app.post('/loans', requirePermission('loan:create'), async (req, res) => {
    const { borrowerId, productCode, principalPaise, tenure } = req.body ?? {};
    const loan = await createLoan(pool, { borrowerId, productCode, principalPaise, tenure }, req.user.id, meta(req));
    res.status(201).json(toCamel(loan));
  });

  app.get('/loans/:id', requirePermission('read'), async (req, res) => {
    const id = requireUuid(req.params.id, 'Loan');
    const loan = await getLoan(pool, id);
    res.json({ ...toCamel(loan), balances: await loanLedgerBalances(pool, id) });
  });

  app.post('/loans/:id/disburse', requirePermission('loan:disburse'), async (req, res) => {
    const id = requireUuid(req.params.id, 'Loan');
    const { disbursedOn } = req.body ?? {};
    const result = await disburseLoan(pool, { loanId: id, disbursedOn }, req.user.id, meta(req));
    res.json({
      loan: toCamel(result.loan),
      transactionId: result.transactionId,
      instalments: result.schedule.length,
    });
  });

  app.get('/loans/:id/schedule', requirePermission('read'), async (req, res) => {
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

  // Step 5 (D31): every repayment must carry an Idempotency-Key header.
  // A repeat with the same key returns the original response (same status,
  // same body, replayed: true) and posts nothing.
  app.post('/loans/:id/repayments', requirePermission('repayment:post'), async (req, res) => {
    const id = requireUuid(req.params.id, 'Loan');
    const idempotencyKey = req.get('Idempotency-Key');
    if (!idempotencyKey) {
      throw new ValidationError('Send an Idempotency-Key header (a unique value per payment, reused on retries)');
    }
    const { amountPaise, effectiveDate, externalEventId } = req.body ?? {};
    const result = await postRepayment(
      pool, { loanId: id, amountPaise, effectiveDate, externalEventId, idempotencyKey }, req.user.id, meta(req));
    res.status(201).set('Idempotent-Replayed', String(result.replayed)).json(result);
  });

  // ----- ledger -----
  app.get('/ledger/trial-balance', requirePermission('ledger:read'), async (req, res) => {
    res.json(await trialBalance(pool));
  });

  // ----- audit trail (D44): newest first; filter with ?entityType=loan&entityId=<id> -----
  app.get('/audit', requirePermission('audit:read'), async (req, res) => {
    const { entityType = null, entityId = null } = req.query;
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit ?? '100', 10) || 100, 1), 500);
    const rows = await listAudit(pool, { entityType, entityId, limit });
    res.json(rows.map(toCamel));
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
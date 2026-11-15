-- =====================================================================
-- 001_initial_schema.sql
-- Loan Account Ledger Service: core data model.
--
-- MONEY RULE (D1): every amount is a BIGINT number of paise. No floats,
-- no NUMERIC columns for money. Column names end in _paise so this is
-- obvious at every call site.
-- RATE RULE  (D3): every rate is an INTEGER number of basis points
-- (1 bp = 0.01%), so 24.00% p.a. is stored as 2400.
-- =====================================================================

-- ---------- Enumerated types ----------------------------------------
CREATE TYPE user_role        AS ENUM ('OFFICER', 'MANAGER', 'AUDITOR');
CREATE TYPE schedule_type    AS ENUM ('FLAT', 'REDUCING');
CREATE TYPE repay_frequency  AS ENUM ('WEEKLY', 'MONTHLY');
CREATE TYPE loan_status      AS ENUM ('CREATED', 'DISBURSED', 'CLOSED');
CREATE TYPE account_type     AS ENUM ('ASSET', 'LIABILITY', 'INCOME');
CREATE TYPE entry_direction  AS ENUM ('DEBIT', 'CREDIT');
CREATE TYPE txn_type         AS ENUM (
  'DISBURSEMENT', 'REPAYMENT', 'INTEREST_ACCRUAL', 'PENALTY_ACCRUAL', 'REVERSAL'
);

-- ---------- Staff users (for role-based access, Step 7) -------------
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username      TEXT NOT NULL UNIQUE,
  role          user_role NOT NULL,
  -- We store only a SHA-256 hash of the API key, never the key itself.
  api_key_hash  TEXT NOT NULL UNIQUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Borrowers -----------------------------------------------
CREATE TABLE borrowers (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  external_ref  TEXT NOT NULL UNIQUE,          -- e.g. a customer number from an upstream system
  full_name     TEXT NOT NULL,
  phone         TEXT,
  created_by    UUID NOT NULL REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Loan products (templates) -------------------------------
CREATE TABLE loan_products (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code                 TEXT NOT NULL UNIQUE,
  name                 TEXT NOT NULL,
  schedule_type        schedule_type   NOT NULL,
  frequency            repay_frequency NOT NULL,
  annual_rate_bps      INTEGER NOT NULL CHECK (annual_rate_bps  >= 0),
  penalty_rate_bps     INTEGER NOT NULL CHECK (penalty_rate_bps >= 0),  -- p.a., charged on overdue amounts
  grace_days           INTEGER NOT NULL DEFAULT 0 CHECK (grace_days >= 0),
  min_principal_paise  BIGINT  NOT NULL CHECK (min_principal_paise > 0),
  max_principal_paise  BIGINT  NOT NULL,
  min_tenure           INTEGER NOT NULL CHECK (min_tenure > 0),         -- in instalments
  max_tenure           INTEGER NOT NULL,
  active               BOOLEAN NOT NULL DEFAULT true,
  CHECK (max_principal_paise >= min_principal_paise),
  CHECK (max_tenure >= min_tenure)
);

-- ---------- Loans ----------------------------------------------------
-- D4: the product's terms are COPIED onto the loan when it is created.
-- Changing a product later must never change an existing loan.
CREATE TABLE loans (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  borrower_id       UUID NOT NULL REFERENCES borrowers(id),
  product_id        UUID NOT NULL REFERENCES loan_products(id),
  principal_paise   BIGINT NOT NULL CHECK (principal_paise > 0),
  -- snapshot of product terms (D4)
  schedule_type     schedule_type   NOT NULL,
  frequency         repay_frequency NOT NULL,
  annual_rate_bps   INTEGER NOT NULL CHECK (annual_rate_bps  >= 0),
  penalty_rate_bps  INTEGER NOT NULL CHECK (penalty_rate_bps >= 0),
  grace_days        INTEGER NOT NULL CHECK (grace_days >= 0),
  tenure            INTEGER NOT NULL CHECK (tenure > 0),
  status            loan_status NOT NULL DEFAULT 'CREATED',
  disbursed_on      DATE,
  first_due_date    DATE,
  closed_on         DATE,
  created_by        UUID NOT NULL REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A disbursed loan must know when it was disbursed and when the first instalment is due.
  CHECK (status = 'CREATED' OR (disbursed_on IS NOT NULL AND first_due_date IS NOT NULL))
);
CREATE INDEX loans_borrower_idx ON loans (borrower_id);

-- ---------- Repayment schedule --------------------------------------
-- D9: this is the contractual PLAN (what is due). It holds no "paid"
-- column: what has been paid is derived from ledger entries that
-- reference the instalment.
CREATE TABLE schedule_instalments (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id             UUID NOT NULL REFERENCES loans(id),
  instalment_no       INTEGER NOT NULL CHECK (instalment_no > 0),
  due_date            DATE    NOT NULL,
  principal_due_paise BIGINT  NOT NULL CHECK (principal_due_paise >= 0),
  interest_due_paise  BIGINT  NOT NULL CHECK (interest_due_paise  >= 0),
  UNIQUE (loan_id, instalment_no)
);
CREATE INDEX schedule_loan_due_idx ON schedule_instalments (loan_id, due_date);

-- ---------- Chart of accounts ---------------------------------------
-- D5: company-wide accounts have loan_id NULL (BANK, INTEREST_INCOME, ...).
-- Each loan gets its own receivable accounts (PRINCIPAL_RECEIVABLE, ...).
CREATE TABLE accounts (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code      TEXT NOT NULL,
  type      account_type NOT NULL,
  loan_id   UUID REFERENCES loans(id),
  -- NULLS NOT DISTINCT (Postgres 15+) makes ('BANK', NULL) unique too;
  -- by default two NULLs are treated as different values.
  UNIQUE NULLS NOT DISTINCT (code, loan_id)
);

-- ---------- Ledger transactions (one business event each) -----------
CREATE TABLE ledger_transactions (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id                  UUID REFERENCES loans(id),
  type                     txn_type NOT NULL,
  -- D8: effective_date = when it happened in the real world;
  --     posted_at      = when this system recorded it.
  effective_date           DATE NOT NULL,
  posted_at                TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  -- Step 5 (idempotency): a client-supplied key; the UNIQUE constraint is
  -- the final safety net against double-posting.
  idempotency_key          TEXT UNIQUE,
  external_event_id        TEXT,          -- e.g. a payment-gateway reference
  reverses_transaction_id  UUID REFERENCES ledger_transactions(id),
  memo                     TEXT,
  created_by               UUID NOT NULL REFERENCES users(id)
);
CREATE INDEX ledger_txn_loan_eff_idx ON ledger_transactions (loan_id, effective_date);

-- ---------- Ledger entries (the debit/credit lines) -----------------
CREATE TABLE ledger_entries (
  id              BIGSERIAL PRIMARY KEY,
  transaction_id  UUID NOT NULL REFERENCES ledger_transactions(id),
  account_id      UUID NOT NULL REFERENCES accounts(id),
  direction       entry_direction NOT NULL,
  -- Always positive; the direction column carries the sign.
  amount_paise    BIGINT NOT NULL CHECK (amount_paise > 0),
  instalment_id   UUID REFERENCES schedule_instalments(id)   -- D9
);
CREATE INDEX ledger_entries_txn_idx        ON ledger_entries (transaction_id);
CREATE INDEX ledger_entries_account_idx    ON ledger_entries (account_id);
CREATE INDEX ledger_entries_instalment_idx ON ledger_entries (instalment_id);

-- ---------- D7: the database itself enforces debits = credits -------
-- A DEFERRED constraint trigger runs at COMMIT, after all lines of a
-- transaction have been inserted. If they don't balance, the whole
-- database transaction is rolled back. This guards against bugs in
-- application code, not just in the happy path.
CREATE FUNCTION check_ledger_txn_balanced() RETURNS trigger AS $$
DECLARE
  txn_id      UUID;
  total_dr    BIGINT;
  total_cr    BIGINT;
  line_count  INTEGER;
BEGIN
  IF TG_TABLE_NAME = 'ledger_entries' THEN
    txn_id := NEW.transaction_id;
  ELSE
    txn_id := NEW.id;
  END IF;

  SELECT COALESCE(SUM(amount_paise) FILTER (WHERE direction = 'DEBIT'),  0),
         COALESCE(SUM(amount_paise) FILTER (WHERE direction = 'CREDIT'), 0),
         COUNT(*)
    INTO total_dr, total_cr, line_count
    FROM ledger_entries
   WHERE transaction_id = txn_id;

  IF line_count < 2 THEN
    RAISE EXCEPTION 'Ledger transaction % has % entries; at least 2 are required', txn_id, line_count;
  END IF;
  IF total_dr <> total_cr THEN
    RAISE EXCEPTION 'Ledger transaction % is unbalanced: debits % <> credits %', txn_id, total_dr, total_cr;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Fires for every entry line ...
CREATE CONSTRAINT TRIGGER ledger_entries_balanced
  AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_ledger_txn_balanced();

-- ... and for every transaction header, which catches a header with no lines at all.
CREATE CONSTRAINT TRIGGER ledger_txn_has_entries
  AFTER INSERT ON ledger_transactions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_ledger_txn_balanced();

-- ---------- D6: the ledger is append-only ---------------------------
-- Corrections are new REVERSAL transactions, never edits.
CREATE FUNCTION forbid_modification() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_entries_append_only
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_modification();

CREATE TRIGGER ledger_transactions_append_only
  BEFORE UPDATE OR DELETE ON ledger_transactions
  FOR EACH ROW EXECUTE FUNCTION forbid_modification();

-- ---------- Idempotency records (fully used in Step 5) --------------
CREATE TABLE idempotency_records (
  key             TEXT PRIMARY KEY,
  user_id         UUID NOT NULL REFERENCES users(id),
  request_hash    TEXT NOT NULL,         -- detects "same key, different body"
  status          TEXT NOT NULL CHECK (status IN ('IN_PROGRESS', 'COMPLETED')),
  response_code   INTEGER,
  response_body   JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ
);

-- ---------- Audit trail (fully used in Step 7) ----------------------
CREATE TABLE audit_log (
  id           BIGSERIAL PRIMARY KEY,
  actor_id     UUID NOT NULL REFERENCES users(id),
  action       TEXT NOT NULL,           -- e.g. 'LOAN_CREATED', 'REPAYMENT_POSTED'
  entity_type  TEXT NOT NULL,
  entity_id    TEXT NOT NULL,
  before       JSONB,
  after        JSONB,
  request_id   TEXT,
  at           TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX audit_entity_idx ON audit_log (entity_type, entity_id);

CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_modification();

-- ---------- D6: balances are DERIVED, never stored ------------------
-- raw_balance_paise     = debits - credits
-- natural_balance_paise = the balance as you'd normally read it:
--   assets are debit-normal; liabilities and income are credit-normal.
CREATE VIEW account_balances AS
SELECT a.id      AS account_id,
       a.code,
       a.type,
       a.loan_id,
       COALESCE(SUM(CASE e.direction WHEN 'DEBIT' THEN e.amount_paise
                                     ELSE -e.amount_paise END), 0)::BIGINT AS raw_balance_paise,
       (CASE WHEN a.type = 'ASSET' THEN 1 ELSE -1 END) *
       COALESCE(SUM(CASE e.direction WHEN 'DEBIT' THEN e.amount_paise
                                     ELSE -e.amount_paise END), 0)::BIGINT AS natural_balance_paise
  FROM accounts a
  LEFT JOIN ledger_entries e ON e.account_id = a.id
 GROUP BY a.id;
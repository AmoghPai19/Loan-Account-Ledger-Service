-- =====================================================================
-- 002_seed_reference_data.sql
-- Reference data that every environment needs.
-- =====================================================================

-- Company-wide ledger accounts (D5). Per-loan receivable accounts are
-- created by the application when a loan is created.
INSERT INTO accounts (code, type, loan_id) VALUES
  ('BANK',             'ASSET',     NULL),   -- money in/out of our bank account
  ('INTEREST_INCOME',  'INCOME',    NULL),
  ('PENALTY_INCOME',   'INCOME',    NULL),
  ('BORROWER_ADVANCE', 'LIABILITY', NULL);   -- overpayments we owe back / hold for borrowers

-- The three loan products.
-- Rates in basis points (D3), amounts in paise (D1).
INSERT INTO loan_products
  (code, name, schedule_type, frequency, annual_rate_bps, penalty_rate_bps, grace_days,
   min_principal_paise, max_principal_paise, min_tenure, max_tenure)
VALUES
  -- Rs.5,000 - Rs.50,000, 24% p.a. reducing, weekly, 25-52 weeks
  ('WGL', 'Weekly Group Loan', 'REDUCING', 'WEEKLY',  2400, 3600, 2,
      500000,   5000000, 25, 52),
  -- Rs.20,000 - Rs.5,00,000, 18% p.a. reducing, monthly, 6-36 months
  ('EMI', 'Monthly EMI Loan',  'REDUCING', 'MONTHLY', 1800, 2400, 5,
     2000000,  50000000,  6, 36),
  -- Rs.10,000 - Rs.2,00,000, 12% p.a. flat, monthly, 6-24 months
  ('FLT', 'Flat-Rate Loan',    'FLAT',     'MONTHLY', 1200, 2400, 5,
     1000000,  20000000,  6, 24);

-- Development users, one per role. The plain-text keys below are for
-- LOCAL DEVELOPMENT ONLY; only their SHA-256 hashes are stored.
INSERT INTO users (username, role, api_key_hash) VALUES
  ('officer.asha',   'OFFICER', encode(sha256('dev-officer-key'::bytea), 'hex')),
  ('manager.ravi',   'MANAGER', encode(sha256('dev-manager-key'::bytea), 'hex')),
  ('auditor.meera',  'AUDITOR', encode(sha256('dev-auditor-key'::bytea), 'hex')),
  -- A system user that scheduled jobs (accrual, replay) act as, so every
  -- ledger transaction and audit row still has a real actor.
  ('system',         'MANAGER', encode(sha256('dev-system-key-not-for-http'::bytea), 'hex'));
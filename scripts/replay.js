// =====================================================================
// replay.js: feeds the synthetic events through the real service, in
// ARRIVAL order, and reports whether the ledger is right (Step 9).
//
//   npm run replay
//     1. creates a FRESH database "ledger_replay" (your dev data is untouched)
//     2. creates every borrower and loan; a manager disburses each loan
//     3. walks through the events day by day, in arrival order:
//          - the accrual job runs before every 7th simulated day (D59)
//          - each day, up to 8 LOANS are processed at the same time; each
//            loan's own events go one by one in arrival order, so the
//            report is identical on every run (D60)
//          - every event uses its eventId as the Idempotency-Key (D58)
//     4. runs the accrual job one last time, checks everything, and writes
//        reports/replay-report.md and reports/replay-report.json
// =====================================================================
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPool } from '../src/db/pool.js';
import { migrate } from './migrate.js';
import { createBorrower, createLoan, disburseLoan, postRepayment } from '../src/services/loans.js';
import { runAccruals, systemUserId } from '../src/jobs/accrual.js';
import { trialBalance } from '../src/ledger/ledger.js';
import { ConflictError } from '../src/errors.js';
import { addDays, daysBetween } from '../src/domain/dates.js';
import { formatPaise } from '../src/domain/money.js';

/** Run fn over items, at most `limit` at a time. */
async function inParallel(items, limit, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

/**
 * Label every event in ARRIVAL order (D61):
 *   duplicate     its eventId has already arrived
 *   out-of-order  first arrival, but a LATER-dated payment for the same loan arrived before it
 *   in-order      everything else
 */
export function classifyArrivals(events) {
  const seen = new Set();
  const latestPaidOn = new Map();
  return events.map((e) => {
    if (seen.has(e.eventId)) return 'duplicate';
    seen.add(e.eventId);
    const latest = latestPaidOn.get(e.loanRef);
    if (!latest || e.paidOn > latest) latestPaidOn.set(e.loanRef, e.paidOn);
    return latest && e.paidOn < latest ? 'out-of-order' : 'in-order';
  });
}

export async function runReplay(pool, dataset, { accrualEveryDays = 7, concurrency = 8, log = () => {} } = {}) {
  const started = Date.now();
  const users = Object.fromEntries((await pool.query('SELECT username, id FROM users')).rows.map((u) => [u.username, u.id]));
  const officer = users['officer.asha'];
  const manager = users['manager.ravi'];
  const system = await systemUserId(pool);

  // ---- 1. borrowers and loans ----
  const borrowerIds = new Map();
  for (const b of dataset.borrowers) {
    borrowerIds.set(b.externalRef, (await createBorrower(pool, b, officer)).id);
  }
  const loanIds = new Map();
  for (const l of dataset.loans) {
    const loan = await createLoan(pool, {
      borrowerId: borrowerIds.get(l.borrowerRef), productCode: l.productCode,
      principalPaise: l.principalPaise, tenure: l.tenure,
    }, officer);
    await disburseLoan(pool, { loanId: loan.id, disbursedOn: l.disbursedOn }, manager);
    loanIds.set(l.externalRef, loan.id);
  }
  log(`Created ${borrowerIds.size} borrowers and ${loanIds.size} disbursed loans`);

  // ---- 2. events, day by day in arrival order ----
  const kinds = classifyArrivals(dataset.events);
  const outcome = new Array(dataset.events.length);
  const byDay = new Map();
  dataset.events.forEach((e, i) => {
    const day = e.receivedAt.slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(i);
  });

  const accruals = { runs: 0, interestAccruedPaise: 0, penaltyChargedPaise: 0, penaltyReversedPaise: 0, failures: 0 };
  const accrue = async (asOf) => {
    const t = await runAccruals(pool, { asOf, actorId: system });
    accruals.runs += 1;
    accruals.interestAccruedPaise += t.interestAccruedPaise;
    accruals.penaltyChargedPaise += t.penaltyChargedPaise;
    accruals.penaltyReversedPaise += t.penaltyReversedPaise;
    accruals.failures += t.failures.length;
  };

  let lastAccrualDay = dataset.loans.reduce((min, l) => (l.disbursedOn < min ? l.disbursedOn : min), '9999-12-31');
  const days = [...byDay.keys()].sort();
  for (const day of days) {
    if (daysBetween(lastAccrualDay, day) >= accrualEveryDays) {
      await accrue(addDays(day, -1)); // the nightly job, before this day's payments arrive
      lastAccrualDay = day;
    }
    const perLoan = new Map();
    for (const i of byDay.get(day)) {
      const ref = dataset.events[i].loanRef;
      if (!perLoan.has(ref)) perLoan.set(ref, []);
      perLoan.get(ref).push(i);
    }
    await inParallel([...perLoan.values()], concurrency, async (indexes) => {
      for (const i of indexes) {
        const e = dataset.events[i];
        try {
          const r = await postRepayment(pool, {
            loanId: loanIds.get(e.loanRef), amountPaise: e.amountPaise, effectiveDate: e.paidOn,
            idempotencyKey: e.eventId, externalEventId: e.eventId,
          }, system);
          outcome[i] = r.replayed ? 'replayed' : 'posted';
        } catch (err) {
          outcome[i] = err instanceof ConflictError ? 'refused' : 'failed';
          if (outcome[i] === 'failed') log(`FAILED ${e.eventId}: ${err.message}`);
        }
      }
    });
  }
  const lastDay = days[days.length - 1];
  await accrue(lastDay);
  log(`Replayed ${dataset.events.length} events over ${days.length} days`);

  return buildReport(pool, dataset, kinds, outcome, accruals, { lastDay, seconds: (Date.now() - started) / 1000 });
}

async function buildReport(pool, dataset, kinds, outcome, accruals, { lastDay, seconds }) {
  const count = (pred) => dataset.events.reduce((n, e, i) => n + (pred(e, i) ? 1 : 0), 0);

  // Duplicates are counted PER EVENT ID (D61): was each event posted at most
  // once, and was every EXTRA delivery answered without posting? (Counting
  // "was the later copy replayed?" is fragile: under concurrency either copy
  // may be the one that wins the race to claim the key.)
  const perEvent = new Map();
  dataset.events.forEach((e, i) => {
    if (!perEvent.has(e.eventId)) perEvent.set(e.eventId, []);
    perEvent.get(e.eventId).push(outcome[i]);
  });
  let extraDeliveries = 0;
  let extraDeliveriesAnswered = 0;
  let eventsPostedTwiceInReplay = 0;
  const postedEventIds = new Set();
  for (const [eventId, results] of perEvent) {
    const posted = results.filter((o) => o === 'posted').length;
    if (posted > 1) eventsPostedTwiceInReplay += 1;
    if (posted === 1) postedEventIds.add(eventId);
    extraDeliveries += results.length - 1;
    extraDeliveriesAnswered += posted === 1
      ? results.filter((o) => o === 'replayed').length       // the copies that did not post
      : results.filter((o) => o === 'refused').length - 1;   // refused event: its copies are refused too
  }
  const one = async (sql, params = []) => (await pool.query(sql, params)).rows[0];

  const tb = await trialBalance(pool);
  const postedAmount = dataset.events.reduce((s, e, i) => s + (outcome[i] === 'posted' ? e.amountPaise : 0), 0);

  const checks = {
    trialBalanceBalances: tb.balanced,
    unbalancedTransactions: (await one(
      `SELECT count(*)::int AS n FROM (SELECT transaction_id FROM ledger_entries GROUP BY transaction_id
        HAVING SUM(CASE direction WHEN 'DEBIT' THEN amount_paise ELSE -amount_paise END) <> 0) x`)).n,
    accountsNetToZero: (await one('SELECT COALESCE(SUM(raw_balance_paise), 0)::bigint AS s FROM account_balances')).s === 0,
    eventsPostedMoreThanOnce: (await one(
      `SELECT count(*)::int AS n FROM (SELECT external_event_id FROM ledger_transactions WHERE type = 'REPAYMENT'
        GROUP BY external_event_id HAVING count(*) > 1) x`)).n,
    repaymentTransactions: (await one(`SELECT count(*)::int AS n FROM ledger_transactions WHERE type = 'REPAYMENT'`)).n,
    bankReceivedPaise: (await one(
      `SELECT COALESCE(SUM(e.amount_paise), 0)::bigint AS s FROM ledger_entries e
         JOIN ledger_transactions t ON t.id = e.transaction_id JOIN accounts a ON a.id = e.account_id
        WHERE t.type = 'REPAYMENT' AND a.code = 'BANK' AND e.direction = 'DEBIT'`)).s,
    instalmentsOverpaidOrOveraccrued: (await one(
      `SELECT count(*)::int AS n FROM (
         SELECT s.id,
           s.principal_due_paise AS p_due, s.interest_due_paise AS i_due,
           COALESCE(SUM(e.amount_paise) FILTER (WHERE a.code = 'PRINCIPAL_RECEIVABLE' AND e.direction = 'CREDIT'), 0) AS p_paid,
           COALESCE(SUM(e.amount_paise) FILTER (WHERE a.code = 'INTEREST_RECEIVABLE' AND e.direction = 'CREDIT'), 0) AS i_paid,
           COALESCE(SUM(e.amount_paise) FILTER (WHERE a.code = 'INTEREST_RECEIVABLE' AND e.direction = 'DEBIT'), 0) AS i_accrued
         FROM schedule_instalments s
         LEFT JOIN ledger_entries e ON e.instalment_id = s.id LEFT JOIN accounts a ON a.id = e.account_id
         GROUP BY s.id) x
       WHERE p_paid > p_due OR i_paid > i_due OR i_accrued > i_due`)).n,
    negativeReceivables: (await one(
      `SELECT count(*)::int AS n FROM account_balances WHERE loan_id IS NOT NULL AND natural_balance_paise < 0`)).n,
  };
  checks.repaymentsMatchPostedEvents = checks.repaymentTransactions === count((e, i) => outcome[i] === 'posted');
  checks.bankMatchesPostedAmounts = checks.bankReceivedPaise === postedAmount;

  const company = async (code) => (await one(
    'SELECT natural_balance_paise AS b FROM account_balances WHERE loan_id IS NULL AND code = $1', [code])).b;
  const loanSum = async (code) => (await one(
    'SELECT COALESCE(SUM(natural_balance_paise), 0)::bigint AS s FROM account_balances WHERE loan_id IS NOT NULL AND code = $1', [code])).s;
  const statuses = Object.fromEntries((await pool.query('SELECT status, count(*)::int AS n FROM loans GROUP BY status')).rows.map((r) => [r.status, r.n]));

  const report = {
    dataset: dataset.manifest,
    events: {
      total: dataset.events.length,
      uniqueEventIds: new Set(dataset.events.map((e) => e.eventId)).size,
      inOrder: count((e, i) => kinds[i] === 'in-order'),
      outOfOrder: count((e, i) => kinds[i] === 'out-of-order'),
      duplicates: count((e, i) => kinds[i] === 'duplicate'),
    },
    outcomes: {
      posted: count((e, i) => outcome[i] === 'posted'),
      extraDeliveries,
      extraDeliveriesAnsweredWithoutPosting: extraDeliveriesAnswered,
      answeredFromStoredResult: count((e, i) => outcome[i] === 'replayed'),
      eventsPostedTwiceInReplay,
      outOfOrderPosted: count((e, i) => kinds[i] === 'out-of-order' && postedEventIds.has(e.eventId)),
      eventsRefusedLoanAlreadyClosed: [...perEvent.values()].filter((r) => r.every((o) => o === 'refused')).length,
      failed: count((e, i) => outcome[i] === 'failed'),
    },
    checks,
    ledger: {
      debitsPaise: tb.debitsPaise,
      creditsPaise: tb.creditsPaise,
      disbursedPaise: -(await one(
        `SELECT COALESCE(SUM(CASE e.direction WHEN 'CREDIT' THEN -e.amount_paise ELSE e.amount_paise END), 0)::bigint AS s
           FROM ledger_entries e JOIN ledger_transactions t ON t.id = e.transaction_id JOIN accounts a ON a.id = e.account_id
          WHERE t.type = 'DISBURSEMENT' AND a.code = 'BANK'`)).s,
      repaymentsReceivedPaise: checks.bankReceivedPaise,
      principalOutstandingPaise: await loanSum('PRINCIPAL_RECEIVABLE'),
      interestReceivablePaise: await loanSum('INTEREST_RECEIVABLE'),
      penaltyReceivablePaise: await loanSum('PENALTY_RECEIVABLE'),
      interestIncomePaise: await company('INTEREST_INCOME'),
      penaltyIncomePaise: await company('PENALTY_INCOME'),
      borrowerAdvancePaise: await company('BORROWER_ADVANCE'),
      loans: { disbursed: statuses.DISBURSED ?? 0, closed: statuses.CLOSED ?? 0 },
    },
    accruals,
    finishedSimulatedDay: lastDay,
    seconds: Math.round(seconds),
  };
  report.pass = checks.trialBalanceBalances && checks.unbalancedTransactions === 0 && checks.accountsNetToZero
    && checks.eventsPostedMoreThanOnce === 0 && checks.repaymentsMatchPostedEvents && checks.bankMatchesPostedAmounts
    && checks.instalmentsOverpaidOrOveraccrued === 0 && checks.negativeReceivables === 0 && report.outcomes.failed === 0
    && report.outcomes.eventsPostedTwiceInReplay === 0
    && report.outcomes.extraDeliveries === report.events.duplicates
    && report.outcomes.extraDeliveriesAnsweredWithoutPosting === report.events.duplicates;
  return report;
}

export function reportMarkdown(r) {
  const yes = (ok) => (ok ? 'PASS' : 'FAIL');
  const rs = formatPaise;
  return `# Replay report

**Result: ${r.pass ? 'PASS' : 'FAIL'}**, ${r.events.total} events replayed in ${r.seconds} s (seed ${r.dataset.seed}).

## Dataset
| | |
|---|---|
| Borrowers | ${r.dataset.borrowers} |
| Loans | ${r.dataset.loans} (WGL ${r.dataset.loansByProduct.WGL}, EMI ${r.dataset.loansByProduct.EMI}, FLT ${r.dataset.loansByProduct.FLT}) |
| Events | ${r.events.total} (${r.events.uniqueEventIds} unique payments + ${r.events.duplicates} duplicate deliveries) |
| Payment dates | ${r.dataset.firstPaymentDate} to ${r.dataset.lastPaymentDate} |

## How the events were handled
| | Count |
|---|---|
| First arrivals, in date order | ${r.events.inOrder} |
| **Out-of-order arrivals** (a later-dated payment for the same loan arrived first) | **${r.events.outOfOrder}**, all ${r.outcomes.outOfOrderPosted} posted at their real effective date |
| **Duplicate deliveries** (extra copies of an event id) | **${r.outcomes.extraDeliveries}** |
| &nbsp;&nbsp; answered without posting again | ${r.outcomes.extraDeliveriesAnsweredWithoutPosting} |
| &nbsp;&nbsp; event ids posted more than once | ${r.outcomes.eventsPostedTwiceInReplay} |
| Events refused: loan already fully repaid (409) | ${r.outcomes.eventsRefusedLoanAlreadyClosed} |
| Failed unexpectedly | ${r.outcomes.failed} |
| **Repayments posted** (one per unique event id) | **${r.outcomes.posted}** |

Duplicates are counted per event id: each id must post at most once, and every extra copy must be
answered without posting. ${r.outcomes.answeredFromStoredResult} deliveries were answered from the stored result.

## Checks
| Check | Result |
|---|---|
| Trial balance: total debits = total credits | ${yes(r.checks.trialBalanceBalances)} (${rs(r.ledger.debitsPaise)} each side) |
| Every single transaction balances | ${yes(r.checks.unbalancedTransactions === 0)} (${r.checks.unbalancedTransactions} unbalanced) |
| All account balances net to zero | ${yes(r.checks.accountsNetToZero)} |
| No event posted more than once | ${yes(r.checks.eventsPostedMoreThanOnce === 0)} (${r.checks.eventsPostedMoreThanOnce} posted twice) |
| Repayment transactions = events reported as posted | ${yes(r.checks.repaymentsMatchPostedEvents)} (${r.checks.repaymentTransactions}) |
| Money into the bank = sum of posted events | ${yes(r.checks.bankMatchesPostedAmounts)} (${rs(r.checks.bankReceivedPaise)}) |
| No instalment overpaid, no interest recognised twice | ${yes(r.checks.instalmentsOverpaidOrOveraccrued === 0)} (${r.checks.instalmentsOverpaidOrOveraccrued} instalments) |
| No negative receivable on any loan | ${yes(r.checks.negativeReceivables === 0)} |

## Ledger at the end (${r.finishedSimulatedDay})
| | |
|---|---|
| Disbursed | ${rs(r.ledger.disbursedPaise)} |
| Repayments received | ${rs(r.ledger.repaymentsReceivedPaise)} |
| Principal still outstanding | ${rs(r.ledger.principalOutstandingPaise)} |
| Interest income | ${rs(r.ledger.interestIncomePaise)} (receivable ${rs(r.ledger.interestReceivablePaise)}) |
| Penalty income | ${rs(r.ledger.penaltyIncomePaise)} (receivable ${rs(r.ledger.penaltyReceivablePaise)}) |
| Borrower advances (owed back to borrowers) | ${rs(r.ledger.borrowerAdvancePaise)} |
| Loans | ${r.ledger.loans.disbursed} open, ${r.ledger.loans.closed} closed |

## Accrual job
${r.accruals.runs} runs (weekly, plus a final run). Interest recognised: ${rs(r.accruals.interestAccruedPaise)}.
Penalty charged: ${rs(r.accruals.penaltyChargedPaise)}; reversed after late-arriving payments: ${rs(r.accruals.penaltyReversedPaise)}.
Failures: ${r.accruals.failures}.
`;
}

/** Make an empty "ledger_replay" database next to the one in DATABASE_URL, and migrate it. */
async function freshReplayDatabase() {
  const base = new URL(process.env.DATABASE_URL);
  const admin = new URL(base);
  admin.pathname = '/postgres';
  const replay = new URL(base);
  replay.pathname = '/ledger_replay';
  const adminPool = createPool(admin.toString());
  await adminPool.query('DROP DATABASE IF EXISTS ledger_replay WITH (FORCE)');
  await adminPool.query('CREATE DATABASE ledger_replay');
  await adminPool.end();
  await migrate(replay.toString());
  return createPool(replay.toString());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dataFile = path.resolve(here, '../data/synthetic-dataset.json');
  const dataset = JSON.parse(await readFile(dataFile, 'utf8'));
  const pool = await freshReplayDatabase();
  try {
    const report = await runReplay(pool, dataset, { log: (m) => console.log(m) });
    const outDir = path.resolve(here, '../reports');
    await mkdir(outDir, { recursive: true });
    await writeFile(path.join(outDir, 'replay-report.json'), JSON.stringify(report, null, 2));
    const md = reportMarkdown(report);
    await writeFile(path.join(outDir, 'replay-report.md'), md);
    console.log(`\n${md}`);
    console.log('Written to reports/replay-report.md and reports/replay-report.json');
    process.exitCode = report.pass ? 0 : 1;
  } finally {
    await pool.end();
  }
}
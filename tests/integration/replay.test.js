// Step 9: a smaller replay (400 events) through the real test database.
// `npm run replay` runs the full 5,000.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDatabase } from '../helpers/db.js';
import { generateDataset } from '../../scripts/generate-data.js';
import { runReplay } from '../../scripts/replay.js';

describe('replay of 400 synthetic events', () => {
  let pool;
  let report;

  before(async () => {
    pool = await freshDatabase();
    const dataset = generateDataset({ seed: 7, minBorrowers: 12, totalEvents: 400, duplicateDeliveries: 40, delayedShare: 0.15 });
    report = await runReplay(pool, dataset);
  });
  after(() => pool?.end());

  it('passes every check', () => {
    assert.equal(report.pass, true, JSON.stringify(report.checks));
  });

  it('the ledger balances', () => {
    assert.equal(report.checks.trialBalanceBalances, true);
    assert.equal(report.checks.unbalancedTransactions, 0);
    assert.equal(report.checks.accountsNetToZero, true);
  });

  it('all 40 duplicate deliveries were answered without posting', () => {
    assert.equal(report.outcomes.extraDeliveries, 40);
    assert.equal(report.outcomes.extraDeliveriesAnsweredWithoutPosting, 40);
    assert.equal(report.checks.eventsPostedMoreThanOnce, 0);
    assert.equal(report.outcomes.posted, 360);
  });

  it('out-of-order arrivals were posted, and the money reconciles', () => {
    assert.ok(report.events.outOfOrder > 0);
    assert.equal(report.outcomes.outOfOrderPosted, report.events.outOfOrder);
    assert.equal(report.checks.bankMatchesPostedAmounts, true);
    assert.equal(report.checks.instalmentsOverpaidOrOveraccrued, 0);
  });
});
// =====================================================================
// generate-data.js: invents borrowers, loans and repayment events.
//
//   npm run generate                       -> data/synthetic-dataset.json
//   npm run generate -- --seed 7 --events 5000
//
// All names and phone numbers are invented (D56). Borrowers behave like
// real ones: most pay on time, some late, some split payments, some miss
// an instalment and catch up. Then two delivery problems are added on
// purpose (D57):
//   DUPLICATES    the same event delivered again (a gateway retry):
//                 sometimes seconds later, sometimes days later
//   OUT OF ORDER  an event that reaches us days after it was paid, so it
//                 arrives AFTER later payments by the same borrower
// Events are written in ARRIVAL order (receivedAt), which is the order the
// replay feeds them in.
// =====================================================================
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { seededRandom } from './lib/rng.js';
import { buildSchedule, firstDueDateFor } from '../src/domain/schedule.js';
import { addDays } from '../src/domain/dates.js';

// Must match the products seeded by migrations/002_seed_reference_data.sql.
export const PRODUCTS = {
  WGL: { scheduleType: 'REDUCING', frequency: 'WEEKLY', annualRateBps: 2400, minRupees: 5_000, maxRupees: 50_000, minTenure: 25, maxTenure: 52 },
  EMI: { scheduleType: 'REDUCING', frequency: 'MONTHLY', annualRateBps: 1800, minRupees: 20_000, maxRupees: 5_00_000, minTenure: 6, maxTenure: 36 },
  FLT: { scheduleType: 'FLAT', frequency: 'MONTHLY', annualRateBps: 1200, minRupees: 10_000, maxRupees: 2_00_000, minTenure: 6, maxTenure: 24 },
};

const FIRST_NAMES = ['Aarav', 'Ananya', 'Bhavna', 'Chetan', 'Deepa', 'Farhan', 'Gauri', 'Harish', 'Ishita', 'Jaideep',
  'Kavitha', 'Lokesh', 'Meenal', 'Naveen', 'Oviya', 'Pranav', 'Radhika', 'Sanjay', 'Tanvi', 'Uday',
  'Varsha', 'Yash', 'Zoya', 'Arjun', 'Divya', 'Imran', 'Lakshmi', 'Mohan', 'Nisha', 'Ritu'];
const LAST_NAMES = ['Acharya', 'Bhat', 'Chandran', 'Dsouza', 'Gowda', 'Hegde', 'Iyer', 'Joshi', 'Kamath', 'Kulkarni',
  'Menon', 'Nair', 'Pai', 'Patil', 'Rao', 'Reddy', 'Shenoy', 'Shetty', 'Srinivas', 'Varma'];

/**
 * Build the whole dataset in memory. Pure apart from randomness, which is seeded.
 * @returns { manifest, borrowers, loans, events }
 */
export function generateDataset({
  seed = 20260101,
  minBorrowers = 220,
  totalEvents = 5_000,
  duplicateDeliveries = 300,
  delayedShare = 0.08,
  lastPaymentDate = '2026-10-31',
} = {}) {
  const rnd = seededRandom(seed);
  const uniqueTarget = totalEvents - duplicateDeliveries;

  const borrowers = [];
  const loans = [];
  const payments = [];

  const newBorrower = () => {
    const n = borrowers.length + 1;
    const ref = `BRW-${String(n).padStart(4, '0')}`;
    borrowers.push({
      externalRef: ref,
      fullName: `${rnd.pick(FIRST_NAMES)} ${rnd.pick(LAST_NAMES)}`,
      phone: `+91-00000-${String(n).padStart(5, '0')}`, // deliberately not a real number
    });
    return ref;
  };

  const newLoan = (borrowerRef, earliestDisbursal) => {
    const productCode = rnd.chance(0.5) ? 'WGL' : rnd.chance(0.6) ? 'EMI' : 'FLT';
    const p = PRODUCTS[productCode];
    const principalPaise = rnd.int(p.minRupees / 500, p.maxRupees / 500) * 500 * 100; // multiples of Rs.500
    const tenure = rnd.int(p.minTenure, p.maxTenure);
    const disbursedOn = addDays(earliestDisbursal, rnd.int(0, 60));
    const ref = `LN-${String(loans.length + 1).padStart(4, '0')}`;
    loans.push({ externalRef: ref, borrowerRef, productCode, principalPaise, tenure, disbursedOn });
    paymentsFor(ref, p, principalPaise, tenure, disbursedOn);
  };

  // How one borrower pays one loan (D56).
  const paymentsFor = (loanRef, p, principalPaise, tenure, disbursedOn) => {
    const schedule = buildSchedule({
      principalPaise, annualRateBps: p.annualRateBps, tenure, frequency: p.frequency,
      scheduleType: p.scheduleType, firstDueDate: firstDueDateFor(disbursedOn, p.frequency),
    });
    const totalOwed = schedule.reduce((s, r) => s + r.totalDuePaise, 0);
    let paid = 0;
    let carried = 0; // missed instalments, paid later as a catch-up
    const add = (paidOn, amount) => {
      const capped = Math.min(amount, totalOwed - paid);
      if (capped <= 0 || paidOn > lastPaymentDate || paidOn <= disbursedOn) return;
      payments.push({ loanRef, amountPaise: capped, paidOn });
      paid += capped;
    };
    for (const row of schedule) {
      if (row.dueDate > lastPaymentDate) break;
      const due = row.totalDuePaise + carried;
      carried = 0;
      const r = rnd.next();
      if (r < 0.70) add(addDays(row.dueDate, -rnd.int(0, 2)), due);                 // on time
      else if (r < 0.82) add(addDays(row.dueDate, rnd.int(3, 25)), due);            // late
      else if (r < 0.88) {                                                          // split in two
        const first = Math.floor(due / 2 / 100) * 100;
        add(row.dueDate, first);
        add(addDays(row.dueDate, rnd.int(1, 10)), due - first);
      } else if (r < 0.92) carried = due;                                           // missed: pay next time
      else if (r < 0.96) add(row.dueDate, Math.ceil(due / 10_000) * 10_000);        // rounded up to Rs.100
      else add(addDays(row.dueDate, -rnd.int(3, 6)), due);                          // early
    }
  };

  // Enough borrowers and loans to produce the unique payments we need.
  while (borrowers.length < minBorrowers || payments.length < uniqueTarget) {
    const ref = newBorrower();
    newLoan(ref, '2026-01-05');
    if (rnd.chance(0.2)) newLoan(ref, '2026-02-15'); // some borrowers take a second loan
  }

  // Keep the earliest payments if there are more than needed.
  payments.sort((a, b) => (a.paidOn < b.paidOn ? -1 : a.paidOn > b.paidOn ? 1 : 0));
  payments.length = uniqueTarget;

  // ---- arrival times ----
  const at = (date, hour, minute, second) =>
    `${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}Z`;
  const events = payments.map((p, i) => {
    const delayed = rnd.chance(delayedShare);
    const days = delayed ? rnd.int(3, 30) : rnd.chance(0.1) ? 1 : 0;
    return {
      eventId: `EVT-${String(i + 1).padStart(6, '0')}`,
      loanRef: p.loanRef,
      amountPaise: p.amountPaise,
      paidOn: p.paidOn,
      receivedAt: at(addDays(p.paidOn, days), rnd.int(3, 14), rnd.int(0, 59), rnd.int(0, 59)),
      deliberatelyDelayed: delayed,
    };
  });

  // ---- duplicates: the same event delivered again ----
  for (let i = 0; i < duplicateDeliveries; i++) {
    const original = rnd.pick(events.slice(0, uniqueTarget));
    const t = Date.parse(original.receivedAt);
    const later = rnd.chance(0.4)
      ? t + rnd.int(1, 20) * 1000                       // seconds later: a quick retry
      : t + rnd.int(60, 3 * 24 * 3600) * 1000;          // minutes to 3 days later
    events.push({ ...original, receivedAt: new Date(later).toISOString().replace('.000Z', 'Z'), duplicateDelivery: true });
  }

  // Arrival order.
  events.sort((a, b) => (a.receivedAt < b.receivedAt ? -1 : a.receivedAt > b.receivedAt ? 1 : a.eventId < b.eventId ? -1 : 1));

  return {
    manifest: {
      seed,
      borrowers: borrowers.length,
      loans: loans.length,
      loansByProduct: Object.fromEntries(Object.keys(PRODUCTS).map((c) => [c, loans.filter((l) => l.productCode === c).length])),
      totalEvents: events.length,
      uniqueEvents: uniqueTarget,
      duplicateDeliveries,
      deliberatelyDelayed: events.filter((e) => e.deliberatelyDelayed && !e.duplicateDelivery).length,
      firstPaymentDate: payments[0].paidOn,
      lastPaymentDate: payments[payments.length - 1].paidOn,
    },
    borrowers,
    loans,
    events,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > -1 ? Number(process.argv[i + 1]) : fallback;
  };
  const dataset = generateDataset({ seed: arg('seed', 20260101), totalEvents: arg('events', 5_000) });
  const here = path.dirname(fileURLToPath(import.meta.url));
  const file = path.resolve(here, '../data/synthetic-dataset.json');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(dataset, null, 1));
  console.log(JSON.stringify(dataset.manifest, null, 2));
  console.log(`Written to ${file}`);
}
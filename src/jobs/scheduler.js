// =====================================================================
// scheduler.js: runs the accrual job once a day, inside the API process.
//
// Turned on by setting ACCRUAL_DAILY_AT=HH:MM (India time) in .env, e.g.
//   ACCRUAL_DAILY_AT=01:00
// The same job can also be run by hand, or by cron / Windows Task
// Scheduler, with:   npm run accrue   (see scripts/run-accruals.js)
// =====================================================================
import { runAccruals, systemUserId, todayInIndia } from './accrual.js';

/** Milliseconds from `now` until the next HH:MM in India (UTC+5:30). */
export function msUntilNext(hhmm, now = Date.now()) {
  const [h, m] = hhmm.split(':').map(Number);
  if (!(h >= 0 && h < 24 && m >= 0 && m < 60)) throw new Error(`Bad time "${hhmm}", use HH:MM`);
  const offset = 330 * 60_000;
  const localNow = new Date(now + offset);
  const target = new Date(localNow);
  target.setUTCHours(h, m, 0, 0);
  if (target <= localNow) target.setUTCDate(target.getUTCDate() + 1);
  return target - localNow;
}

export function startDailyAccruals(pool, hhmm, log = console) {
  let timer;
  const runOnce = async () => {
    try {
      const totals = await runAccruals(pool, { asOf: todayInIndia(), actorId: await systemUserId(pool) });
      log.log('[accruals]', JSON.stringify(totals));
    } catch (err) {
      log.error('[accruals] failed:', err); // the next run will catch up: the job is idempotent (D49)
    }
    timer = setTimeout(runOnce, msUntilNext(hhmm));
  };
  timer = setTimeout(runOnce, msUntilNext(hhmm));
  log.log(`[accruals] scheduled daily at ${hhmm} India time`);
  return { stop: () => clearTimeout(timer) };
}
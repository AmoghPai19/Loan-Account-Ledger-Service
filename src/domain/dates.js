// =====================================================================
// dates.js: calendar arithmetic on plain 'YYYY-MM-DD' strings (D13).
//
// Internally we use JavaScript Dates in UTC only, so the computer's
// timezone (IST or anything else) can never shift a date by a day.
// =====================================================================

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function toUtc(date) {
  if (typeof date !== 'string' || !ISO_DATE.test(date)) {
    throw new RangeError(`Not a YYYY-MM-DD date: "${date}"`);
  }
  const d = new Date(`${date}T00:00:00Z`);
  // Rejects impossible dates like 2026-02-30, which JS would silently roll over to March.
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== date) {
    throw new RangeError(`Invalid calendar date: "${date}"`);
  }
  return d;
}

function fromUtc(d) {
  return d.toISOString().slice(0, 10);
}

export function assertIsoDate(date) {
  toUtc(date);
  return date;
}

export function addDays(date, days) {
  const d = toUtc(date);
  d.setUTCDate(d.getUTCDate() + days);
  return fromUtc(d);
}

function daysInMonth(year, monthIndex0) {
  return new Date(Date.UTC(year, monthIndex0 + 1, 0)).getUTCDate();
}

/**
 * Add calendar months, clamping to the end of the month when needed:
 * 2026-01-31 + 1 month = 2026-02-28 (not 2026-03-03).
 */
export function addMonths(date, months) {
  const d = toUtc(date);
  const totalMonths = d.getUTCFullYear() * 12 + d.getUTCMonth() + months;
  const year = Math.floor(totalMonths / 12);
  const month = totalMonths % 12;
  const day = Math.min(d.getUTCDate(), daysInMonth(year, month));
  return fromUtc(new Date(Date.UTC(year, month, day)));
}

/** Whole days from `from` to `to` (positive if `to` is later). */
export function daysBetween(from, to) {
  return Math.round((toUtc(to).getTime() - toUtc(from).getTime()) / 86_400_000);
}

export function compareDates(a, b) {
  return a < b ? -1 : a > b ? 1 : 0; // ISO strings sort correctly as text
}
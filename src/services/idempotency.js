// =====================================================================
// idempotency.js: makes "post a repayment" safe to send more than once.
//
// The client sends an Idempotency-Key it generated for ONE intended
// payment, and reuses it on every retry. We record the key in
// idempotency_records INSIDE the same database transaction as the ledger
// posting (D32), so the key and the money are saved together or not at all.
//
//   first time        -> INSERT succeeds, we post, we store the response
//   repeat / retry    -> INSERT finds the key, we return the stored response
//   arriving together -> Postgres makes the 2nd INSERT WAIT for the 1st
//                        transaction to finish, then it finds the key (D33)
//   same key, different request -> 422, never silently ignored (D34)
// =====================================================================
import { createHash } from 'node:crypto';
import { AppError, ValidationError } from '../errors.js';

/** Same key, different request: a client bug we must not hide. HTTP 422. */
export class IdempotencyKeyReusedError extends AppError {
  constructor(message) { super(message, 422, 'IDEMPOTENCY_KEY_REUSED'); }
}

/** 1-200 printable ASCII characters, e.g. a UUID or "UPI-20260215-0001". */
export function requireIdempotencyKey(key) {
  if (typeof key !== 'string' || !/^[\x21-\x7E]{1,200}$/.test(key)) {
    throw new ValidationError('Idempotency-Key must be 1-200 printable characters with no spaces');
  }
  return key;
}

/** A fingerprint of the request, to spot the same key being reused for a different request. */
export function requestHash(parts) {
  return createHash('sha256').update(JSON.stringify(parts), 'utf8').digest('hex');
}

/**
 * Try to claim the key, inside the caller's database transaction.
 * Returns { claimed: true } the first time, or { claimed: false, responseBody }
 * when this exact request was already completed.
 */
export async function claimKey(client, { key, userId, hash }) {
  const inserted = await client.query(
    `INSERT INTO idempotency_records (key, user_id, request_hash, status)
     VALUES ($1, $2, $3, 'IN_PROGRESS')
     ON CONFLICT (key) DO NOTHING
     RETURNING key`,
    [key, userId, hash],
  );
  if (inserted.rowCount === 1) return { claimed: true };

  // The key exists and is committed (if another transaction was still using
  // it, the INSERT above waited for that transaction to finish first).
  const existing = (await client.query('SELECT * FROM idempotency_records WHERE key = $1', [key])).rows[0];
  if (existing.user_id !== userId || existing.request_hash !== hash) {
    throw new IdempotencyKeyReusedError(
      'This Idempotency-Key was already used for a different request. Use a new key for a new payment.');
  }
  return { claimed: false, responseCode: existing.response_code, responseBody: existing.response_body };
}

/** Store the response, in the same transaction as the work it describes. */
export async function completeKey(client, { key, responseCode, responseBody }) {
  await client.query(
    `UPDATE idempotency_records
        SET status = 'COMPLETED', response_code = $2, response_body = $3, completed_at = now()
      WHERE key = $1`,
    [key, responseCode, JSON.stringify(responseBody)],
  );
}
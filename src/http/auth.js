// =====================================================================
// auth.js: who is calling? (authentication)
//
// Every request must send an API key in the X-API-Key header. We hash it
// with SHA-256 and look the hash up in the users table (D14), so the raw
// key is never stored. The matching user is attached as req.user and
// becomes the "actor" on everything the request writes.
//
// What each role may DO (authorisation) is added in Step 7.
// =====================================================================
import { createHash } from 'node:crypto';

export function hashApiKey(key) {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

export function authenticate(pool) {
  return async (req, res, next) => {
    const key = req.get('X-API-Key');
    if (!key) {
      return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Send your API key in the X-API-Key header' } });
    }
    const { rows } = await pool.query(
      'SELECT id, username, role FROM users WHERE api_key_hash = $1',
      [hashApiKey(key)],
    );
    if (rows.length === 0) {
      return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Unknown API key' } });
    }
    req.user = rows[0];
    return next();
  };
}
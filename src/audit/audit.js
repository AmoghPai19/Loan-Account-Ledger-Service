// =====================================================================
// audit.js: the audit trail (who changed what, and when).
//
// recordAudit() must be called with a client INSIDE the same database
// transaction as the change it describes (D44): the change and its audit
// row are saved together, or neither is. The audit_log table is
// append-only (a trigger from migration 001 rejects UPDATE and DELETE).
// =====================================================================

export async function recordAudit(client, { actorId, action, entityType, entityId, before = null, after = null, requestId = null }) {
  await client.query(
    `INSERT INTO audit_log (actor_id, action, entity_type, entity_id, before, after, request_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [actorId, action, entityType, String(entityId),
      before === null ? null : JSON.stringify(before),
      after === null ? null : JSON.stringify(after),
      requestId],
  );
}

/** Newest first, optionally for one entity (e.g. every change to one loan). */
export async function listAudit(db, { entityType = null, entityId = null, limit = 100 } = {}) {
  const { rows } = await db.query(
    `SELECT a.id, a.at, a.action, a.entity_type, a.entity_id, a.before, a.after, a.request_id,
            u.username AS actor_username, u.role AS actor_role
       FROM audit_log a
       JOIN users u ON u.id = a.actor_id
      WHERE ($1::text IS NULL OR a.entity_type = $1)
        AND ($2::text IS NULL OR a.entity_id = $2)
      ORDER BY a.id DESC
      LIMIT $3`,
    [entityType, entityId, limit],
  );
  return rows;
}
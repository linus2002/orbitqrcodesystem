/**
 * Audit logging.
 *
 * Every state-changing admin action goes through here. The table is
 * append-only by policy: nothing in this codebase updates or deletes an
 * audit row, which is what makes the log admissible during a regulatory
 * track-and-trace audit.
 *
 * The actor's email is denormalised onto the row on purpose, so the trail
 * still reads correctly after a user account is removed.
 */
import * as db from '../db/index.js';
import logger from '../lib/logger.js';

/**
 * Record an auditable action.
 *
 * @param {object}  entry
 * @param {object}  [entry.actor]      the acting user row ({ id, email })
 * @param {string}  entry.action       dotted action name, e.g. 'batch.release'
 * @param {string}  [entry.entityType] 'batch' | 'code' | 'user' | ...
 * @param {string|number} [entry.entityId]
 * @param {object}  [entry.detail]     structured context (avoid secrets)
 * @param {object}  [entry.req]        express request, for ip/user-agent
 */
export async function record({ actor, action, entityType = null, entityId = null, detail = null, req = null }) {
  try {
    await db.run(
      `INSERT INTO audit_log (actor_id, actor_email, action, entity_type, entity_id, detail_json, ip, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        actor?.id ?? null,
        actor?.email ?? null,
        action,
        entityType,
        entityId === null ? null : String(entityId),
        detail ? JSON.stringify(detail) : null,
        req?.clientIp ?? null,
        req?.get?.('user-agent')?.slice(0, 300) ?? null,
      ]
    );
  } catch (err) {
    // An audit write must never take down the operation it is describing,
    // but a failure here is serious and has to be loud in the logs.
    logger.error('AUDIT WRITE FAILED', { action, error: err.message });
  }
}

/** Paged audit trail for the admin dashboard. */
export async function list({ page, pageSize, action, actorId, entityType, from, to } = {}) {
  const { limit, offset, ...meta } = db.paginate({ page, pageSize });
  const where = [];
  const params = [];

  if (action) {
    where.push('action LIKE ?');
    params.push(`${action}%`);
  }
  if (actorId) {
    where.push('actor_id = ?');
    params.push(actorId);
  }
  if (entityType) {
    where.push('entity_type = ?');
    params.push(entityType);
  }
  if (from) {
    where.push('created_at >= ?');
    params.push(from);
  }
  if (to) {
    where.push('created_at <= ?');
    params.push(to);
  }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = await db.scalar(`SELECT COUNT(*) FROM audit_log ${clause}`, params);
  const rows = await db.all(
    `SELECT id, actor_id, actor_email, action, entity_type, entity_id, detail_json, ip, created_at
       FROM audit_log ${clause}
      ORDER BY created_at DESC, id DESC
      LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

  return {
    items: rows.map((r) => ({ ...r, detail: r.detail_json ? JSON.parse(r.detail_json) : null })),
    total,
    ...meta,
  };
}

export default { record, list };

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
    await db.insert('auditLog', {
      actor_id: actor?.id ?? null,
      actor_email: actor?.email ?? null,
      action,
      entity_type: entityType,
      entity_id: entityId === null ? null : String(entityId),
      detail_json: detail ? JSON.stringify(detail) : null,
      ip: req?.clientIp ?? null,
      user_agent: req?.get?.('user-agent')?.slice(0, 300) ?? null,
    });
  } catch (err) {
    // An audit write must never take down the operation it is describing,
    // but a failure here is serious and has to be loud in the logs.
    logger.error('AUDIT WRITE FAILED', { action, error: err.message });
  }
}

/** Paged audit trail for the admin dashboard. */
export async function list({ page, pageSize, action, actorId, entityType, from, to } = {}) {
  const { limit, offset, ...meta } = db.paginate({ page, pageSize });
  const where = {
    // LIKE 'prefix%' - a dotted action family such as 'batch.'
    $raw: action ? 'string::startsWith(action, $actionPrefix)' : undefined,
    actor_id: actorId ? Number(actorId) : undefined,
    entity_type: entityType || undefined,
    created_at: from || to ? { gte: from || undefined, lte: to || undefined } : undefined,
  };
  const params = action ? { actionPrefix: String(action) } : {};

  const total = await db.count('auditLog', where, { params });
  const rows = await db.findMany('auditLog', where, {
    order: ['created_at desc', 'id desc'],
    limit,
    offset,
    fields: ['id', 'actor_id', 'actor_email', 'action', 'entity_type', 'entity_id', 'detail_json', 'ip', 'created_at'],
    params,
  });

  return {
    items: rows.map((r) => ({ ...r, detail: r.detail_json ? JSON.parse(r.detail_json) : null })),
    total,
    ...meta,
  };
}

export default { record, list };

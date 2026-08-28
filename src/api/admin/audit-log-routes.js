// FILE: src/api/admin/audit-log-routes.js
// GET /api/admin/audit-log?event=&limit= — the admin-facing view of the
// append-only audit_log. Mounted behind requireAdmin (server.js), before the
// generic /api/admin router.
//
// READ ONLY, and deliberately so: audit_log has no update or delete path
// anywhere in the codebase, and this router does not introduce one.

import { Router } from 'express';
import { asyncHandler } from '../../middleware/async-handler-middleware.js';
import { listRecent as defaultListRecent } from '../../services/dpdp/audit-log-service.js';
import { AUDIT_EVENTS } from '../../models/dpdp/dpdp-constants.js';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/** "50" → 50. Anything unparseable falls back to the default; capped at 500. */
export function parseLimit(limit) {
  const parsed = parseInt(String(limit ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}

/** An unrecognised event filter is ignored rather than erroring to an empty page. */
export function parseEvent(event) {
  const value = typeof event === 'string' ? event.trim() : '';
  return Object.values(AUDIT_EVENTS).includes(value) ? value : undefined;
}

/** Rows are already narrow; ids are stringified for the client. */
function toPublicEntry(entry) {
  return {
    id: entry._id.toString(),
    event: entry.event,
    actorType: entry.actorType ?? null,
    actorId: entry.actorId ? entry.actorId.toString() : null,
    targetType: entry.targetType ?? null,
    targetId: entry.targetId ? entry.targetId.toString() : null,
    metadata: entry.metadata ?? {},
    createdAt: entry.createdAt ?? null,
  };
}

/** Deps are injectable so route tests need no database. */
export function createAuditLogRouter(deps = {}) {
  const { listRecent = defaultListRecent } = deps;
  const router = Router();

  router.get('/', asyncHandler(async (req, res) => {
    const entries = await listRecent({
      event: parseEvent(req.query?.event),
      limit: parseLimit(req.query?.limit),
    });
    res.json({
      data: {
        entries: entries.map(toPublicEntry),
        events: Object.values(AUDIT_EVENTS),
      },
    });
  }));

  return router;
}

export default createAuditLogRouter;

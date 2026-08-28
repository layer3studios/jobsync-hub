// FILE: src/services/dpdp/audit-log-service.js
// Thin service over the audit_log model. Exposes append + reads only — no update
// or delete path exists anywhere (C7). Used by consent- and rights-request-service.

import {
  appendAuditLog, listAuditForActor, listAuditByEvent, listRecentAuditEntries,
} from '../../models/dpdp/audit-log-model.js';

export function appendAudit(entry) {
  return appendAuditLog(entry);
}

export function listForActor(actorId, { limit = 50 } = {}) {
  return listAuditForActor(actorId, { limit });
}

export function listByEvent(event, { limit = 50 } = {}) {
  return listAuditByEvent(event, { limit });
}

/** Newest entries across every actor, for the admin audit viewer. */
export function listRecent({ event, limit = 100 } = {}) {
  return listRecentAuditEntries({ event, limit });
}

// FILE: src/api/admin/admin-dpdp-routes.js
// The DPDP ops queue: list open rights requests and fulfil them. Mounted under
// /api/admin/dpdp by admin-routes, which has already applied requireAdmin — these
// endpoints are never reachable without an admin session.
//
// Fulfilment is a POST, not a DELETE, because it is an action on a request rather
// than a removal of one: the request row survives, marked fulfilled, as the evidence
// that the obligation was met.

import { Router } from 'express';
import { asyncHandler } from '../../middleware/async-handler-middleware.js';
import {
  listOpenRightsRequests, toPublicRightsRequest,
} from '../../models/dpdp/rights-request-model.js';
import { RIGHTS_REQUEST_TYPES } from '../../models/dpdp/dpdp-constants.js';
import { fulfillErasureRequest } from '../../services/dpdp/erasure-service.js';

const router = Router();

/** Actor stamped onto the audit entry — who pressed the button, not "the system". */
const adminActor = (req) => ({ type: 'admin', id: req.adminUser?.adminUserId ?? null });

// GET /api/admin/dpdp/rights-requests?type=erasure — the open queue, oldest due first.
router.get('/rights-requests', asyncHandler(async (req, res) => {
  const type = req.query.type;
  const types = Object.values(RIGHTS_REQUEST_TYPES).includes(type) ? [type] : undefined;
  const requests = await listOpenRightsRequests({ types });
  res.json({ requests: requests.map(toPublicRightsRequest) });
}));

// POST /api/admin/dpdp/rights-requests/:id/fulfil — erase one Data Principal.
// 404 when the id is unknown, 400 when the request is not an erasure request; an
// already-fulfilled request answers 200 with alreadyFulfilled: true.
router.post('/rights-requests/:id/fulfil', asyncHandler(async (req, res) => {
  const result = await fulfillErasureRequest(req.params.id, { actor: adminActor(req) });
  res.json({ result });
}));

// POST /api/admin/dpdp/rights-requests/fulfil-all — drain the open erasure queue.
// Per-request failures are reported, never thrown: one bad row must not strand the
// rest of a queue that is running against a statutory deadline.
router.post('/rights-requests/fulfil-all', asyncHandler(async (req, res) => {
  const pending = await listOpenRightsRequests({ types: [RIGHTS_REQUEST_TYPES.ERASURE] });
  const succeeded = [];
  const failed = [];
  for (const request of pending) {
    try {
      succeeded.push(await fulfillErasureRequest(request._id, { actor: adminActor(req) }));
    } catch (error) {
      failed.push({ id: request._id.toString(), message: error.message });
    }
  }
  res.json({ total: pending.length, successCount: succeeded.length, succeeded, failed });
}));

export default router;

// FILE: src/api/employer/employer-archive-reasons-routes.js
// Read-only archive-reason list for the archive dropdown (D7). Mounted at
// /api/employer/archive-reasons behind requireEmployer + requireEmployerCompany.
// No CRUD in this step — the 7 defaults seeded in Step 3A are enough for MVP.

import { Router } from 'express';
import { asyncHandler } from '../../middleware/async-handler-middleware.js';
import { requireInterviewerOrHigher } from '../../middleware/require-company-role-middleware.js';
import { listArchiveReasonsForCompany } from '../../models/employer/archive-reason-model.js';

const router = Router();

function toPublicArchiveReason(doc) {
  return {
    id: doc._id.toString(),
    text: doc.text,
    type: doc.type,
    status: doc.status ?? 'active',
  };
}

// GET /api/employer/archive-reasons — the company's rejection/closure categories.
router.get('/', requireInterviewerOrHigher, asyncHandler(async (req, res) => {
  const reasons = await listArchiveReasonsForCompany(req.employerCompanyId);
  res.json({ reasons: reasons.map(toPublicArchiveReason) });
}));

export default router;

// FILE: src/api/employer/employer-stages-routes.js
// Read-only stage list for the move dropdown (D7). Mounted at /api/employer/stages
// behind requireEmployer + requireEmployerCompany. No CRUD in this step — the 5
// defaults seeded in Step 3A are enough for MVP. Company is read from the request.

import { Router } from 'express';
import { asyncHandler } from '../../middleware/async-handler-middleware.js';
import { requireInterviewerOrHigher } from '../../middleware/require-company-role-middleware.js';
import { listStagesForCompany } from '../../models/employer/stage-model.js';

const router = Router();

function toPublicStage(doc) {
  return {
    id: doc._id.toString(),
    text: doc.text,
    order: doc.order,
    isTerminal: doc.isTerminal ?? false,
    isDefault: doc.isDefault ?? false,
    terminalType: doc.terminalType ?? null,
  };
}

// GET /api/employer/stages — the company's pipeline columns, in order.
router.get('/', requireInterviewerOrHigher, asyncHandler(async (req, res) => {
  const stages = await listStagesForCompany(req.employerCompanyId);
  res.json({ stages: stages.map(toPublicStage) });
}));

export default router;

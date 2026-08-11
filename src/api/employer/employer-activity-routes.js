// FILE: src/api/employer/employer-activity-routes.js
// Company-wide activity feed. Mounted at /api/employer behind requireEmployer +
// requireEmployerCompany (server.js). requireInterviewerOrHigher attaches
// req.companyMemberRole, which the service uses to narrow an interviewer's feed
// to their own actions.

import { Router } from 'express';
import { asyncHandler } from '../../middleware/async-handler-middleware.js';
import { requireInterviewerOrHigher } from '../../middleware/require-company-role-middleware.js';
import { buildCompanyActivity } from '../../services/employer/company-activity-service.js';

const router = Router();

// GET /api/employer/activity?limit=50&before=<ISO> — newest first, paged backwards.
router.get('/activity', requireInterviewerOrHigher, asyncHandler(async (req, res) => {
  const data = await buildCompanyActivity(req.employerCompanyId, {
    limit: req.query.limit,
    before: req.query.before ?? null,
    viewerRole: req.companyMemberRole,
    viewerUserId: req.employerUser.employerUserId,
  });
  res.json(data);
}));

export default router;

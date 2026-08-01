// FILE: src/api/employer/employer-dashboard-routes.js
// Employer dashboard reads. Mounted at /api/employer/dashboard behind
// requireEmployer + requireEmployerCompany (server.js). The company is always
// req.employerCompanyId — never request input (§6.5). One summary call returns
// everything the dashboard needs: no five-round-trip page loads.

import { Router } from 'express';
import { asyncHandler } from '../../middleware/async-handler-middleware.js';
import { buildDashboardSummary } from '../../services/employer/dashboard-summary-service.js';
import { buildDashboardActivity } from '../../services/employer/dashboard-activity-service.js';

const router = Router();

// GET /api/employer/dashboard/summary — KPIs + active jobs + top candidates.
router.get('/summary', asyncHandler(async (req, res) => {
  const data = await buildDashboardSummary(req.employerCompanyId);
  res.json({ data });
}));

// GET /api/employer/dashboard/activity?limit=20 — recent hiring events.
router.get('/activity', asyncHandler(async (req, res) => {
  const data = await buildDashboardActivity(req.employerCompanyId, { limit: req.query.limit });
  res.json({ data });
}));

export default router;

// FILE: src/api/employer/employer-saved-views-routes.js
// Per-recruiter saved filter views on a posting's applicant list. Mounted at
// /api/employer/jobs behind requireEmployer + requireEmployerCompany
// (server.js), so the company is tenant-verified; requireEmployerPosting
// verifies the posting; views are additionally scoped to the current
// employerUserId so one recruiter can never see or touch another's views.

import { Router } from 'express';
import { asyncHandler } from '../../middleware/async-handler-middleware.js';
import { HttpError } from '../../middleware/error-handler-middleware.js';
import { requireEmployerPosting } from '../../middleware/require-employer-posting-middleware.js';
import { requireInterviewerOrHigher } from '../../middleware/require-company-role-middleware.js';
import {
  listSavedViews, createSavedView, updateSavedView, deleteSavedView, toPublicSavedView,
} from '../../models/employer/saved-view-model.js';

const router = Router();

const viewScope = (req) => [req.employerCompanyId, req.posting._id, req.employerUser.employerUserId];

// GET /api/employer/jobs/:postingId/saved-views — this recruiter's views.
router.get('/:postingId/saved-views', requireInterviewerOrHigher, requireEmployerPosting, asyncHandler(async (req, res) => {
  const views = await listSavedViews(...viewScope(req));
  res.json({ views: views.map(toPublicSavedView) });
}));

// POST /api/employer/jobs/:postingId/saved-views — { name, filters }.
router.post('/:postingId/saved-views', requireInterviewerOrHigher, requireEmployerPosting, asyncHandler(async (req, res) => {
  try {
    const view = await createSavedView(...viewScope(req), {
      name: req.body?.name,
      filters: req.body?.filters,
    });
    res.status(201).json({ view: toPublicSavedView(view) });
  } catch (err) {
    if (err.statusCode) throw new HttpError(err.statusCode, err.message);
    throw err;
  }
}));

// PATCH /api/employer/jobs/:postingId/saved-views/:viewId — { name?, filters? }.
router.patch('/:postingId/saved-views/:viewId', requireInterviewerOrHigher, requireEmployerPosting, asyncHandler(async (req, res) => {
  try {
    const view = await updateSavedView(...viewScope(req), req.params.viewId, {
      name: req.body?.name,
      filters: req.body?.filters,
    });
    if (!view) throw new HttpError(404, 'Saved view not found');
    res.json({ view: toPublicSavedView(view) });
  } catch (err) {
    if (err.statusCode) throw new HttpError(err.statusCode, err.message);
    throw err;
  }
}));

// DELETE /api/employer/jobs/:postingId/saved-views/:viewId
router.delete('/:postingId/saved-views/:viewId', requireInterviewerOrHigher, requireEmployerPosting, asyncHandler(async (req, res) => {
  const deleted = await deleteSavedView(...viewScope(req), req.params.viewId);
  if (!deleted) throw new HttpError(404, 'Saved view not found');
  res.json({ message: 'Saved view deleted.' });
}));

export default router;

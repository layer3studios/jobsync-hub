// FILE: src/api/employer/employer-tag-routes.js
// The company's candidate-tag library + the per-application tag list. Mounted at
// /api/employer behind requireEmployer + requireEmployerCompany (server.js), so
// the company is tenant-verified; requireEmployerApplicant verifies :applicationId.
//
// READ is Interviewer+, WRITE is Member+: an interviewer can see how a candidate
// is labelled but cannot relabel them, and cannot reshape the shared library.

import { Router } from 'express';
import { asyncHandler } from '../../middleware/async-handler-middleware.js';
import { HttpError } from '../../middleware/error-handler-middleware.js';
import { requireEmployerApplicant } from '../../middleware/require-employer-applicant-middleware.js';
import {
  requireInterviewerOrHigher, requireMemberOrHigher,
} from '../../middleware/require-company-role-middleware.js';
import {
  createTag, listTags, deleteTag, resolveTagNames, toPublicTag,
} from '../../models/employer/candidate-tag-model.js';
import { setApplicationTags } from '../../models/public/application-model.js';
import { toEmployerApplication } from '../../services/employer/applicant-mappers.js';

const router = Router();

/** Model-layer errors carry a statusCode; re-throw everything else untouched. */
function asHttpError(err) {
  return err.statusCode ? new HttpError(err.statusCode, err.message) : err;
}

// GET /api/employer/tags — the company's tag library, alphabetical.
router.get('/tags', requireInterviewerOrHigher, asyncHandler(async (req, res) => {
  const tags = await listTags(req.employerCompanyId);
  res.json({ tags: tags.map(toPublicTag) });
}));

// POST /api/employer/tags — { name }. 201 on create, 200 when it already existed.
router.post('/tags', requireMemberOrHigher, asyncHandler(async (req, res) => {
  try {
    const { tag, created } = await createTag(req.employerCompanyId, req.body?.name);
    res.status(created ? 201 : 200).json({ tag: toPublicTag(tag), created });
  } catch (err) {
    throw asHttpError(err);
  }
}));

// DELETE /api/employer/tags/:tagId — removes the tag from the library AND from
// every application carrying it.
router.delete('/tags/:tagId', requireMemberOrHigher, asyncHandler(async (req, res) => {
  const { deleted, applicationsUpdated } = await deleteTag(req.employerCompanyId, req.params.tagId);
  if (!deleted) throw new HttpError(404, 'Tag not found', 'TAG_NOT_FOUND');
  res.json({ message: 'Tag deleted.', applicationsUpdated });
}));

// PUT /api/employer/applicants/:applicationId/tags — { tags: ['referral', …] }.
// Replaces the whole list, so the client sends the state it wants rather than a diff.
router.put(
  '/applicants/:applicationId/tags',
  requireMemberOrHigher,
  requireEmployerApplicant,
  asyncHandler(async (req, res) => {
    let names;
    try {
      names = await resolveTagNames(req.employerCompanyId, req.body?.tags);
    } catch (err) {
      throw asHttpError(err);
    }
    const updated = await setApplicationTags(req.employerCompanyId, req.application._id, names);
    if (!updated) throw new HttpError(404, 'Application not found', 'APPLICATION_NOT_FOUND');
    res.json({ application: toEmployerApplication(updated) });
  }),
);

export default router;

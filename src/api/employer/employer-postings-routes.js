// FILE: src/api/employer/employer-postings-routes.js
// Native posting CRUD. Mounted at /api/employer/jobs behind requireEmployer +
// requireEmployerCompany (server.js). The owning company is always read from
// req.employerCompanyId — never from request input (§6.5). URLs say "jobs" per
// spec §6.3; code says "Posting" per glossary §15.

import { Router } from 'express';
import { asyncHandler } from '../../middleware/async-handler-middleware.js';
import { HttpError } from '../../middleware/error-handler-middleware.js';
import { requireEmployerPosting } from '../../middleware/require-employer-posting-middleware.js';
import {
  requireInterviewerOrHigher, requireMemberOrHigher,
} from '../../middleware/require-company-role-middleware.js';
import {
  createPostingForCompany, listPostingsForCompany, updatePostingForCompany,
  closePostingForCompany, reopenPostingForCompany, toPublicPosting,
} from '../../models/employer/posting-model.js';
import {
  validatePostingTitle, validatePostingDescription, validatePostingLocation,
  validateWorkplaceType, validateEmploymentType, validateSalary, validatePostingStatus,
} from '../../services/employer/posting-validators.js';
import { extractAndStoreRequirements } from '../../gemma/background-extractor.js';
import { listApplicantsForPosting } from './employer-applicants-controller.js';

/**
 * Fire-and-forget JD extraction; never blocks or fails the HTTP response (D6/D8).
 * `force` drops any existing parsedRequirements so a description edit re-extracts
 * (the extractor skips docs that still carry the field).
 */
function fireExtraction(posting, { force = false } = {}) {
  const doc = force ? { ...posting, parsedRequirements: undefined } : posting;
  extractAndStoreRequirements(doc).catch(
    (err) => console.warn('[gemma] background extraction failed:', err.message),
  );
}

const router = Router();
const PATCHABLE_FIELDS = [
  'title', 'description', 'location', 'workplaceType', 'employmentType',
  'salaryMin', 'salaryMax', 'status',
];

/** Validate + normalize a create body into the model input shape. */
function buildCreateInput(body) {
  const status = body.status === undefined ? 'active' : validatePostingStatus(body.status);
  const { salaryMin, salaryMax } = validateSalary(body.salaryMin, body.salaryMax);
  return {
    title: validatePostingTitle(body.title),
    description: validatePostingDescription(body.description),
    location: validatePostingLocation(body.location),
    workplaceType: validateWorkplaceType(body.workplaceType),
    employmentType: validateEmploymentType(body.employmentType),
    salaryMin, salaryMax, status,
  };
}

/** Validate a PATCH body: reject unknown keys (incl. companyId/slug), normalize. */
function buildPatch(body, current) {
  for (const key of Object.keys(body)) {
    if (!PATCHABLE_FIELDS.includes(key)) {
      throw new HttpError(400, `Unknown field: ${key}`, 'UNKNOWN_FIELD');
    }
  }
  const patch = {};
  if ('title' in body) patch.title = validatePostingTitle(body.title);
  if ('description' in body) {
    patch.description = validatePostingDescription(body.description);
    patch.descriptionPlain = patch.description;
  }
  if ('location' in body) patch.location = validatePostingLocation(body.location);
  if ('workplaceType' in body) patch.workplaceType = validateWorkplaceType(body.workplaceType);
  if ('employmentType' in body) patch.employmentType = validateEmploymentType(body.employmentType);
  if ('status' in body) patch.status = validatePostingStatus(body.status);
  if ('salaryMin' in body || 'salaryMax' in body) {
    const min = 'salaryMin' in body ? body.salaryMin : current.salaryMin;
    const max = 'salaryMax' in body ? body.salaryMax : current.salaryMax;
    const normalized = validateSalary(min, max);
    patch.salaryMin = normalized.salaryMin;
    patch.salaryMax = normalized.salaryMax;
  }
  if (Object.keys(patch).length === 0) {
    throw new HttpError(400, 'No valid fields to update', 'EMPTY_PATCH');
  }
  return patch;
}

// POST /api/employer/jobs — create (default status 'active').
router.post('/', requireMemberOrHigher, asyncHandler(async (req, res) => {
  const input = buildCreateInput(req.body || {});
  const posting = await createPostingForCompany(
    req.employerCompanyId, input, req.employerUser.employerUserId,
  );
  fireExtraction(posting);
  res.status(201).json({ posting: toPublicPosting(posting) });
}));

// GET /api/employer/jobs — list, optional ?status= filter.
router.get('/', requireInterviewerOrHigher, asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.status !== undefined) filter.status = validatePostingStatus(req.query.status);
  const postings = await listPostingsForCompany(req.employerCompanyId, filter);
  res.json({ postings: postings.map(toPublicPosting) });
}));

// GET /api/employer/jobs/:postingId — single posting.
router.get('/:postingId', requireInterviewerOrHigher, requireEmployerPosting, (req, res) => {
  res.json({ posting: toPublicPosting(req.posting) });
});

// PATCH /api/employer/jobs/:postingId — update mutable fields.
router.patch('/:postingId', requireMemberOrHigher, requireEmployerPosting, asyncHandler(async (req, res) => {
  const patch = buildPatch(req.body || {}, req.posting);
  const posting = await updatePostingForCompany(req.employerCompanyId, req.posting._id, patch);
  // Re-extract only when the description actually changed — not on status-only edits.
  if ('description' in patch) fireExtraction(posting, { force: true });
  res.json({ posting: toPublicPosting(posting) });
}));

// GET /api/employer/jobs/:postingId/applicants — applications + contact + score.
router.get('/:postingId/applicants', requireInterviewerOrHigher, requireEmployerPosting, asyncHandler(listApplicantsForPosting));

// POST /api/employer/jobs/:postingId/close — status → 'closed'.
router.post('/:postingId/close', requireMemberOrHigher, requireEmployerPosting, asyncHandler(async (req, res) => {
  const posting = await closePostingForCompany(req.employerCompanyId, req.posting._id);
  res.json({ posting: toPublicPosting(posting) });
}));

// POST /api/employer/jobs/:postingId/reopen — status → 'active'.
router.post('/:postingId/reopen', requireMemberOrHigher, requireEmployerPosting, asyncHandler(async (req, res) => {
  const posting = await reopenPostingForCompany(req.employerCompanyId, req.posting._id);
  res.json({ posting: toPublicPosting(posting) });
}));

export default router;

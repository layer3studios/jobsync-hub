// FILE: src/api/employer/employer-assignments-routes.js
// The employer assignment library. Mounted at /api/employer/assignments behind
// requireEmployer + requireEmployerCompany (server.js), exactly like
// /api/employer/jobs. The owning company always comes from req.employerCompanyId
// — never from request input (§6.5) — so a cross-tenant id simply misses the
// filter and 404s rather than 403ing, which would confirm the row exists.
//
// Attaching an assignment to a posting is Chunk 3; this router is library CRUD only.

import { Router } from 'express';
import { asyncHandler } from '../../middleware/async-handler-middleware.js';
import { HttpError } from '../../middleware/error-handler-middleware.js';
import {
  requireInterviewerOrHigher, requireMemberOrHigher, requireOwnerOrHigher,
} from '../../middleware/require-company-role-middleware.js';
import {
  insertAssignment, listAssignmentsForCompany, getAssignmentForCompany,
  updateAssignmentForCompany, archiveAssignmentForCompany, unarchiveAssignmentForCompany,
  listJobTitlesUsingAssignment, toPublicAssignment,
} from '../../models/employer/assignment-model.js';
import {
  validateAssignmentTitle, validateAssignmentPublicSummary, validateAssignmentDescription,
  validateSubmissionInstructions, validateEstimatedHours, validateAllowedFileTypes,
} from '../../services/employer/assignment-validators.js';

const router = Router();

const PATCHABLE_FIELDS = [
  'title', 'publicSummary', 'descriptionMarkdown', 'estimatedHours',
  'submissionInstructionsMarkdown', 'allowedFileTypes',
];

/** Validate + normalize a create body into the model input shape. */
function buildCreateInput(body) {
  return {
    title: validateAssignmentTitle(body.title),
    publicSummary: validateAssignmentPublicSummary(body.publicSummary),
    descriptionMarkdown: validateAssignmentDescription(body.descriptionMarkdown),
    estimatedHours: validateEstimatedHours(body.estimatedHours),
    submissionInstructionsMarkdown: validateSubmissionInstructions(body.submissionInstructionsMarkdown),
    allowedFileTypes: validateAllowedFileTypes(body.allowedFileTypes),
  };
}

/** Validate a PATCH body: reject unknown keys (incl. companyId), normalize. */
function buildPatch(body) {
  for (const key of Object.keys(body)) {
    if (!PATCHABLE_FIELDS.includes(key)) {
      throw new HttpError(400, `Unknown field: ${key}`, 'UNKNOWN_FIELD');
    }
  }
  const patch = {};
  if ('title' in body) patch.title = validateAssignmentTitle(body.title);
  if ('publicSummary' in body) patch.publicSummary = validateAssignmentPublicSummary(body.publicSummary);
  if ('descriptionMarkdown' in body) patch.descriptionMarkdown = validateAssignmentDescription(body.descriptionMarkdown);
  if ('estimatedHours' in body) patch.estimatedHours = validateEstimatedHours(body.estimatedHours);
  if ('submissionInstructionsMarkdown' in body) {
    patch.submissionInstructionsMarkdown = validateSubmissionInstructions(body.submissionInstructionsMarkdown);
  }
  if ('allowedFileTypes' in body) patch.allowedFileTypes = validateAllowedFileTypes(body.allowedFileTypes);
  if (Object.keys(patch).length === 0) {
    throw new HttpError(400, 'No valid fields to update', 'EMPTY_PATCH');
  }
  return patch;
}

/** Load an assignment for the caller's company or 404 — never 403 (existence stays hidden). */
async function loadAssignmentOr404(req) {
  const assignment = await getAssignmentForCompany(req.employerCompanyId, req.params.assignmentId);
  if (!assignment) throw new HttpError(404, 'Assignment not found', 'ASSIGNMENT_NOT_FOUND');
  return assignment;
}

/**
 * Refuse a mutation once any native posting references this assignment, and say
 * WHICH postings — the `jobs` array is why this responds directly instead of
 * throwing HttpError, which carries only a message and a code.
 *
 * Once candidates are answering a task, its text is frozen: an edit would mean two
 * candidates answered materially different questions under one snapshot, and the
 * employer would be comparing them as if they were the same. Cloning is the escape
 * hatch — the clone is unattached, so it is freely editable.
 *
 * Returns true when it has already sent the 409; the caller must then stop.
 */
async function refusedAsInUse(req, res, assignmentId, message, code) {
  const jobs = await listJobTitlesUsingAssignment(req.employerCompanyId, assignmentId);
  if (jobs.length === 0) return false;
  res.status(409).json({ error: message, code, jobs });
  return true;
}

// GET /api/employer/assignments — list; ?includeArchived=true to include retired ones.
router.get('/', requireInterviewerOrHigher, asyncHandler(async (req, res) => {
  const includeArchived = req.query.includeArchived === 'true';
  const assignments = await listAssignmentsForCompany(req.employerCompanyId, { includeArchived });
  res.json({ assignments: assignments.map(toPublicAssignment) });
}));

// GET /api/employer/assignments/:assignmentId — single assignment.
router.get('/:assignmentId', requireInterviewerOrHigher, asyncHandler(async (req, res) => {
  const assignment = await loadAssignmentOr404(req);
  res.json({ assignment: toPublicAssignment(assignment) });
}));

// POST /api/employer/assignments — create. A Member can create a posting, so a
// Member must be able to create the assignment they intend to attach to it.
router.post('/', requireMemberOrHigher, asyncHandler(async (req, res) => {
  const input = buildCreateInput(req.body || {});
  const assignment = await insertAssignment({
    ...input,
    companyId: req.employerCompanyId,
    createdByEmployerUserId: req.employerUser.employerUserId,
  });
  res.status(201).json({ assignment: toPublicAssignment(assignment) });
}));

// PATCH /api/employer/assignments/:assignmentId — update, unless it is in use.
router.patch('/:assignmentId', requireMemberOrHigher, asyncHandler(async (req, res) => {
  const current = await loadAssignmentOr404(req);
  const patch = buildPatch(req.body || {});
  const refused = await refusedAsInUse(
    req, res, current._id,
    'This assignment is in use and cannot be edited. Clone it instead.',
    'CANNOT_EDIT_USED_ASSIGNMENT',
  );
  if (refused) return;
  const assignment = await updateAssignmentForCompany(req.employerCompanyId, current._id, patch);
  res.json({ assignment: toPublicAssignment(assignment) });
}));

// POST /api/employer/assignments/:assignmentId/clone — deep content copy.
// Cloning an ARCHIVED assignment is allowed: that is precisely how you revive and
// edit a retired task without disturbing the frozen original.
router.post('/:assignmentId/clone', requireMemberOrHigher, asyncHandler(async (req, res) => {
  const original = await loadAssignmentOr404(req);
  const assignment = await insertAssignment({
    companyId: req.employerCompanyId,
    title: `${original.title} (copy)`,
    publicSummary: original.publicSummary,
    descriptionMarkdown: original.descriptionMarkdown,
    estimatedHours: original.estimatedHours,
    submissionInstructionsMarkdown: original.submissionInstructionsMarkdown,
    allowedFileTypes: [...(original.allowedFileTypes ?? [])],
    createdByEmployerUserId: req.employerUser.employerUserId,
  });
  res.status(201).json({ assignment: toPublicAssignment(assignment) });
}));

// PATCH /api/employer/assignments/:assignmentId/archive — retire, unless in use.
router.patch('/:assignmentId/archive', requireOwnerOrHigher, asyncHandler(async (req, res) => {
  const current = await loadAssignmentOr404(req);
  const refused = await refusedAsInUse(
    req, res, current._id,
    'This assignment is in use and cannot be archived.',
    'CANNOT_ARCHIVE_USED_ASSIGNMENT',
  );
  if (refused) return;
  const assignment = await archiveAssignmentForCompany(req.employerCompanyId, current._id);
  res.json({ assignment: toPublicAssignment(assignment) });
}));

// PATCH /api/employer/assignments/:assignmentId/unarchive — always permitted:
// restoring a task to the library attaches it to nothing on its own.
router.patch('/:assignmentId/unarchive', requireOwnerOrHigher, asyncHandler(async (req, res) => {
  const current = await loadAssignmentOr404(req);
  const assignment = await unarchiveAssignmentForCompany(req.employerCompanyId, current._id);
  res.json({ assignment: toPublicAssignment(assignment) });
}));

export default router;

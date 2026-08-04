// FILE: src/api/employer/posting-assignment-handlers.js
// GET + PATCH /api/employer/jobs/:postingId/assignment. Split out of
// employer-postings-routes.js the same way employer-applicants-controller.js is,
// so the router file stays a readable table of routes.
//
// Both run behind requireEmployerPosting, so req.posting is already tenant-verified
// AND already known to be source:'native' — a scraped ATS job id never reaches here.

import { HttpError } from '../../middleware/error-handler-middleware.js';
import { ObjectId } from 'mongodb';
import { toPublicPosting } from '../../models/employer/posting-model.js';
import {
  getPostingAssignmentContext, setPostingAssignment,
} from '../../services/employer/posting-assignment-service.js';

/**
 * Read assignmentId out of a PATCH body.
 *
 * An explicit null means DETACH and is valid input; a missing key means the caller
 * forgot to send one. Those are different mistakes, so they get different codes —
 * a client must never be able to detach by accidentally omitting a field.
 */
function readAssignmentId(body) {
  for (const key of Object.keys(body)) {
    if (key !== 'assignmentId') {
      throw new HttpError(400, `Unknown field: ${key}`, 'UNKNOWN_FIELD');
    }
  }
  if (!('assignmentId' in body) || body.assignmentId === undefined) {
    throw new HttpError(400, 'assignmentId is required (use null to detach)', 'MISSING_ASSIGNMENT_ID');
  }
  const { assignmentId } = body;
  if (assignmentId === null) return null;
  if (typeof assignmentId !== 'string' || !ObjectId.isValid(assignmentId)) {
    throw new HttpError(400, 'assignmentId must be an assignment id or null', 'INVALID_ASSIGNMENT_ID');
  }
  return assignmentId;
}

/** GET /:postingId/assignment — the attached assignment + the applicant count. */
export async function getPostingAssignment(req, res) {
  const context = await getPostingAssignmentContext(req.employerCompanyId, req.posting);
  res.json(context);
}

/** PATCH /:postingId/assignment — attach, swap, or detach ({ assignmentId: null }). */
export async function patchPostingAssignment(req, res) {
  const assignmentId = readAssignmentId(req.body || {});
  const { posting, previousAssignmentId, applicationCount } = await setPostingAssignment(
    req.employerCompanyId, req.posting, assignmentId,
  );
  res.json({ posting: toPublicPosting(posting), previousAssignmentId, applicationCount });
}

// FILE: src/services/employer/posting-assignment-service.js
// Attaching / detaching a take-home assignment on a native posting. Sits between
// the route (which has already tenant-verified the posting via
// requireEmployerPosting) and the two models, so the attach rules live in one
// place rather than in a handler.
//
// The applicant count is returned on BOTH paths because the UI needs it: the
// confirm dialog (Chunk 7) asks "this posting has 7 applicants, change anyway?"
// before the call, and the post-hoc toast repeats it after. The backend's job is
// to expose the number — it never blocks on it, since the employer already
// confirmed client-side.

import { HttpError } from '../../middleware/error-handler-middleware.js';
import { setPostingAssignmentForCompany } from '../../models/employer/posting-model.js';
import { getAssignmentForCompany, toPublicAssignment } from '../../models/employer/assignment-model.js';
import { countApplicationsForJob } from '../../models/public/application-model.js';

/**
 * What the assignment panel on a posting needs: the currently attached assignment
 * (or null) plus how many people have applied. A dangling assignmentId — the row
 * was hard-deleted out from under the posting — degrades to null rather than
 * throwing; it should not happen, and a 500 on a read is a worse outcome than an
 * empty panel.
 */
export async function getPostingAssignmentContext(companyId, posting) {
  const applicationCount = await countApplicationsForJob(companyId, posting._id);
  if (!posting.assignmentId) return { assignment: null, applicationCount };
  const assignment = await getAssignmentForCompany(companyId, posting.assignmentId);
  return { assignment: assignment ? toPublicAssignment(assignment) : null, applicationCount };
}

/**
 * Attach (assignmentId set) or detach (assignmentId null) in one call.
 *
 * Detach short-circuits every check: it is always allowed and always idempotent.
 * Submissions already made live on `applications` / `assignment_submissions` and
 * are untouched by detaching, so past candidates stay reviewable forever.
 *
 * Attach refuses an ARCHIVED assignment — but only here, at attach time. A posting
 * that already references an assignment archived afterwards keeps working; the
 * snapshot the candidate answers is taken at apply time regardless.
 *
 * previousAssignmentId is read off the posting BEFORE the write so the caller can
 * tell a swap from a first attach without a second round trip.
 */
export async function setPostingAssignment(companyId, posting, assignmentId) {
  const previousAssignmentId = posting.assignmentId?.toString() ?? null;

  if (assignmentId !== null) {
    const assignment = await getAssignmentForCompany(companyId, assignmentId);
    if (!assignment) {
      throw new HttpError(404, 'Assignment not found', 'ASSIGNMENT_NOT_FOUND');
    }
    if (assignment.archivedAt) {
      throw new HttpError(400, 'This assignment is archived and cannot be attached', 'ASSIGNMENT_ARCHIVED');
    }
  }

  const updated = await setPostingAssignmentForCompany(companyId, posting._id, assignmentId);
  const applicationCount = await countApplicationsForJob(companyId, posting._id);
  return { posting: updated, previousAssignmentId, applicationCount };
}

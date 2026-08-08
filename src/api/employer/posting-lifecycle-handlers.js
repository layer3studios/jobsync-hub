// FILE: src/api/employer/posting-lifecycle-handlers.js
// Reopen and delete handlers for a native posting. Split out of
// employer-postings-routes.js (line cap) the same way the assignment handlers were.
// Both assume requireEmployerPosting has already put the tenant-scoped posting on
// req.posting, so neither re-reads it.

import { HttpError } from '../../middleware/error-handler-middleware.js';
import {
  reopenPostingForCompany, deletePostingForCompany, toPublicPosting,
} from '../../models/employer/posting-model.js';
import { countApplicationsForJob } from '../../models/public/application-model.js';

/**
 * POST /:postingId/reopen — status → 'active'.
 *
 * Refuses once the deadline has passed: reopening then yields a posting that reads
 * as active but whose apply endpoint answers 410 on every submission — visibly
 * open, functionally shut. The message names the field to change first.
 */
export async function reopenPosting(req, res) {
  const deadline = req.posting.applicationDeadline;
  if (deadline && new Date(deadline).getTime() <= Date.now()) {
    throw new HttpError(
      409,
      "Can't reopen — the application deadline has passed. Edit the deadline first.",
      'DEADLINE_PASSED',
    );
  }
  const posting = await reopenPostingForCompany(req.employerCompanyId, req.posting._id);
  res.json({ posting: toPublicPosting(posting) });
}

/**
 * DELETE /:postingId — permanently remove a posting.
 *
 * Draft-only and zero-applicants only: a posting that was ever public has a slug
 * candidates may hold, and one with applicants owns rows that would be orphaned.
 * Everything else closes instead, which is what the UI offers.
 */
export async function deletePosting(req, res) {
  if (req.posting.status !== 'draft') {
    throw new HttpError(400, 'Only a draft posting can be deleted. Close it instead.', 'NOT_A_DRAFT');
  }
  // Counted here, never trusted from the client: the list's applicantCount is a
  // render-time snapshot and an application can land between the two.
  const applicantCount = await countApplicationsForJob(req.employerCompanyId, req.posting._id);
  if (applicantCount > 0) {
    throw new HttpError(400, 'This posting has applicants and cannot be deleted.', 'HAS_APPLICANTS');
  }
  const deleted = await deletePostingForCompany(req.employerCompanyId, req.posting._id);
  if (!deleted) throw new HttpError(404, 'Posting not found', 'POSTING_NOT_FOUND');
  res.json({ deleted: true, id: req.posting._id.toString() });
}

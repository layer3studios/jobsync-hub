// FILE: src/services/employer/posting-fill-service.js
// "Position filled": close a posting AND archive everyone still waiting on it, in
// one action. Two separate write sets — there is no transaction here, and one is
// not worth adding: closing first means that even if archiving dies halfway, the
// posting stops taking new applicants and a retry simply archives the remainder.
// Both halves are idempotent.
//
// Deliberately NOT routed through bulkArchiveApplicants: that helper caps a request
// at 50 ids, and a filled posting can easily have more candidates than that. It
// reuses archiveApplicant per item for identical semantics (stage_change, audit
// trail, rejection email) without inheriting the cap.

import { HttpError } from '../../middleware/error-handler-middleware.js';
import { getPostingForCompany, closePostingForCompany } from '../../models/employer/posting-model.js';
import { listApplicationsForJob } from '../../models/public/application-model.js';
import { listArchiveReasonsForCompany } from '../../models/employer/archive-reason-model.js';
import { archiveApplicant } from './applicant-archive-service.js';

// Seeded for every company by seedDefaultArchiveReasonsForCompany. Matched
// case-insensitively so a company that renamed the row still resolves.
const POSITION_FILLED_REASON_TEXT = 'position filled';

/** Resolve this company's "Position filled" archive reason. */
async function findPositionFilledReason(companyId) {
  const reasons = await listArchiveReasonsForCompany(companyId);
  return reasons.find(
    (reason) => String(reason.text ?? '').trim().toLowerCase() === POSITION_FILLED_REASON_TEXT,
  ) ?? null;
}

/**
 * Close the posting and archive every non-archived application on it.
 * Returns { posting, closedCount, archivedCount, failedCount }.
 */
export async function fillPosting(companyId, postingId, movedByUserId = null) {
  const posting = await getPostingForCompany(companyId, postingId);
  if (!posting) throw new HttpError(404, 'Posting not found', 'POSTING_NOT_FOUND');
  // Double-close is refused rather than silently repeated: the confirm dialog
  // quotes a candidate count, and re-running it against an already-closed posting
  // means the caller was looking at stale state.
  if (posting.status === 'closed') {
    throw new HttpError(409, 'This posting is already closed.', 'ALREADY_CLOSED');
  }

  const reason = await findPositionFilledReason(companyId);
  if (!reason) {
    throw new HttpError(400, 'No "Position filled" archive reason exists for this company.', 'REASON_NOT_FOUND');
  }

  // Close FIRST so the role stops accepting applications even if archiving
  // partially fails — a candidate applying to a filled role is the worse outcome.
  const closed = await closePostingForCompany(companyId, posting._id);

  const pending = await listApplicationsForJob(companyId, posting._id, { archived: null });
  let archivedCount = 0;
  let failedCount = 0;
  for (const application of pending) {
    try {
      await archiveApplicant(companyId, application._id, { reasonId: reason._id }, movedByUserId);
      archivedCount += 1;
    } catch (err) {
      // Partial success is first-class (matches bulk archive): one bad row must not
      // strand the rest, and the posting is already closed either way.
      failedCount += 1;
      console.warn(`[posting-fill] could not archive ${application._id}: ${err.message}`);
    }
  }

  return {
    posting: closed,
    closedCount: closed ? 1 : 0,
    archivedCount,
    failedCount,
  };
}

// FILE: src/api/employer/employer-assignment-reviews-routes.js
// Reviewing an assignment submission. Mounted at /api/employer/assignment-reviews
// behind requireEmployer + requireEmployerCompany (server.js).
// requireEmployerSubmission tenant-verifies :submissionId, so a cross-tenant id is
// a 404 before any handler runs.
//
// EVERY route here is requireInterviewerOrHigher, NOT requireCanMoveApplicants.
// That capability is the stage-move permission, and a review is semantically a
// note — notes use requireInterviewerOrHigher too. Gating reviews behind move
// permission would stop an Interviewer, who was brought onto the team specifically
// to evaluate take-homes, from recording their evaluation. That defeats the point
// of the role existing.

import { Router } from 'express';
import { asyncHandler } from '../../middleware/async-handler-middleware.js';
import { HttpError } from '../../middleware/error-handler-middleware.js';
import { requireEmployerSubmission } from '../../middleware/require-employer-submission-middleware.js';
import { requireInterviewerOrHigher } from '../../middleware/require-company-role-middleware.js';
import {
  submitAssignmentReview, getAssignmentReviewFor,
} from '../../services/employer/assignment-review-service.js';
import {
  signAssignmentFileToken, ASSIGNMENT_FILE_TTL_MS,
} from '../../services/employer/assignment-signed-url-service.js';

const router = Router();

const REVIEW_FIELDS = ['overallScore', 'passesBar', 'reviewNotesMarkdown', 'expectedReviewedAt'];

/** Reject unknown keys so a typo'd field is never silently ignored. */
function assertKnownFields(body) {
  for (const key of Object.keys(body)) {
    if (!REVIEW_FIELDS.includes(key)) {
      throw new HttpError(400, `Unknown field: ${key}`, 'UNKNOWN_FIELD');
    }
  }
}

// GET /api/employer/assignment-reviews/:submissionId — the review, or null.
router.get('/:submissionId', requireInterviewerOrHigher, requireEmployerSubmission, asyncHandler(async (req, res) => {
  const review = await getAssignmentReviewFor(req.employerCompanyId, req.assignmentSubmission._id);
  res.json({ review });
}));

// PUT /api/employer/assignment-reviews/:submissionId — create or replace the review.
router.put('/:submissionId', requireInterviewerOrHigher, requireEmployerSubmission, asyncHandler(async (req, res) => {
  const body = req.body || {};
  assertKnownFields(body);

  const { review, conflict, conflictingReviewer } = await submitAssignmentReview(
    req.employerCompanyId, req.assignmentSubmission, req.employerUser.employerUserId, body,
  );

  if (conflict) {
    // The 409 carries the FULL winning review, not just a code. The reviewer who
    // lost the race needs to read what their colleague actually wrote before
    // deciding whether to override it — showing the two side by side is the whole
    // point. `currentReview.reviewedAt` is also the lock version they must echo
    // back to override, so the response is self-sufficient: no re-fetch needed.
    return res.status(409).json({
      error: 'Another reviewer submitted a review while you were writing yours.',
      code: 'REVIEW_CONFLICT',
      currentReview: review,
      conflictingReviewer,
    });
  }
  res.json({ review });
}));

// GET /api/employer/assignment-reviews/:submissionId/files/:fileId/download-url
router.get(
  '/:submissionId/files/:fileId/download-url',
  requireInterviewerOrHigher, requireEmployerSubmission,
  asyncHandler(async (req, res) => {
    const submission = req.assignmentSubmission;
    const entry = (submission.files ?? []).find(
      (file) => String(file.fileId) === String(req.params.fileId),
    );
    if (!entry) throw new HttpError(404, 'File not found', 'FILE_NOT_FOUND');
    // Checked AFTER the file lookup so an unknown id is still a 404: the tombstone
    // says the bytes are gone, which is a different answer from "no such file".
    if (submission.filesDeletedAt) {
      throw new HttpError(410, 'These files have been deleted.', 'FILES_DELETED');
    }

    // storagePath is signed into the token but NEVER returned — the employer gets
    // an opaque URL, exactly as with resume downloads.
    const token = signAssignmentFileToken(entry.storagePath);
    res.json({
      url: `/api/public/assignment-download?token=${token}`,
      expiresAt: new Date(Date.now() + ASSIGNMENT_FILE_TTL_MS).toISOString(),
    });
  }),
);

export default router;

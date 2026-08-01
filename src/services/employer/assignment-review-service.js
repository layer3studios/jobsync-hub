// FILE: src/services/employer/assignment-review-service.js
// Recording an employer's verdict on one assignment submission. Sits between the
// route (which has already tenant-verified the submission) and the Chunk 1 model,
// which owns the optimistic lock.
//
// NEVER SILENTLY OVERWRITE. When two reviewers write at once the model reports
// conflict:true and hands back the stored review; this service resolves WHO wrote
// it, because "someone beat you to it" is not actionable — "Rahul reviewed this
// four minutes ago" is. The losing reviewer can then re-submit against the fresh
// reviewedAt, which is the deliberate-override path: the version IS the intent, so
// there is no force flag to get wrong.

import { HttpError } from '../../middleware/error-handler-middleware.js';
import {
  upsertAssignmentReview, getAssignmentReviewForSubmission, toPublicAssignmentReview,
  MIN_OVERALL_SCORE, MAX_OVERALL_SCORE,
} from '../../models/public/assignment-review-model.js';
import { getEmployerUserById } from '../../models/employer/employer-user-model.js';

const MAX_REVIEW_NOTES_LENGTH = 5000;

// Control chars except tab (\t = \x09) and newline (\n = \x0A).
const CONTROL_CHARACTERS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

/** Integer within [1,5] or throw. Rejects 3.5 and '4' — no coercion. */
function requireOverallScore(value) {
  if (!Number.isInteger(value) || value < MIN_OVERALL_SCORE || value > MAX_OVERALL_SCORE) {
    throw new HttpError(
      400, `Overall score must be a whole number between ${MIN_OVERALL_SCORE} and ${MAX_OVERALL_SCORE}.`,
      'INVALID_OVERALL_SCORE',
    );
  }
  return value;
}

/**
 * A real boolean only. The string 'true' is rejected rather than coerced: this
 * field decides whether a candidate cleared the bar, and a client that sends the
 * wrong type has a bug we should surface, not paper over.
 */
function requirePassesBar(value) {
  if (typeof value !== 'boolean') {
    throw new HttpError(400, 'passesBar must be true or false.', 'INVALID_PASSES_BAR');
  }
  return value;
}

/**
 * Review notes. Control characters are stripped BEFORE the length is measured, so
 * invisible padding cannot buy extra characters.
 *
 * Deliberately does NOT reject "<script". These notes are markdown rendered by
 * react-markdown with raw HTML disabled, so a script tag is inert text on the way
 * out, and a reviewer discussing a frontend take-home legitimately pastes one
 * inside a fenced code block. Same reasoning as the Chunk 2 and 4b validators.
 */
function normalizeReviewNotes(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') {
    throw new HttpError(400, 'Review notes must be text.', 'INVALID_NOTES');
  }
  const cleaned = value.replace(CONTROL_CHARACTERS, '').trim();
  if (cleaned.length > MAX_REVIEW_NOTES_LENGTH) {
    throw new HttpError(400, 'Review notes must be 5000 characters or fewer.', 'INVALID_NOTES');
  }
  return cleaned;
}

/**
 * The lock version the caller believes it is writing against. Absent/null means
 * "I believe there is no review yet". A string must parse to a real Date — an
 * unparseable one would otherwise silently degrade into a first-review upsert and
 * clobber the very review the lock exists to protect.
 */
function parseExpectedReviewedAt(value) {
  if (value === undefined || value === null || value === '') return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new HttpError(400, 'expectedReviewedAt is not a valid timestamp.', 'INVALID_EXPECTED_REVIEWED_AT');
    }
    return value;
  }
  if (typeof value !== 'string') {
    throw new HttpError(400, 'expectedReviewedAt is not a valid timestamp.', 'INVALID_EXPECTED_REVIEWED_AT');
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new HttpError(400, 'expectedReviewedAt is not a valid timestamp.', 'INVALID_EXPECTED_REVIEWED_AT');
  }
  return parsed;
}

/** Who holds the winning review — name/email, or null when that user row is gone. */
async function describeReviewer(employerUserId) {
  if (!employerUserId) return null;
  const user = await getEmployerUserById(employerUserId);
  if (!user) return null;
  return { name: user.name ?? null, email: user.email ?? null };
}

/**
 * Create or replace the review for one submission under the model's optimistic
 * lock. Returns { review, conflict, conflictingReviewer } — on conflict, `review`
 * is the CURRENT stored review (the one that won), not the caller's rejected input.
 */
export async function submitAssignmentReview(companyId, submission, reviewerEmployerUserId, input = {}) {
  const data = {
    reviewedByEmployerUserId: reviewerEmployerUserId,
    overallScore: requireOverallScore(input.overallScore),
    passesBar: requirePassesBar(input.passesBar),
    reviewNotesMarkdown: normalizeReviewNotes(input.reviewNotesMarkdown),
  };
  const expectedReviewedAt = parseExpectedReviewedAt(input.expectedReviewedAt);

  const { review, conflict } = await upsertAssignmentReview(
    companyId, submission._id, data, { expectedReviewedAt },
  );

  const conflictingReviewer = conflict ? await describeReviewer(review?.reviewedByEmployerUserId) : null;
  return { review: toPublicAssignmentReview(review), conflict, conflictingReviewer };
}

/** The stored review for one submission, or null. */
export async function getAssignmentReviewFor(companyId, submissionId) {
  const review = await getAssignmentReviewForSubmission(companyId, submissionId);
  return review ? toPublicAssignmentReview(review) : null;
}

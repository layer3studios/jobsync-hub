// FILE: src/services/seeker/resume-review-service.js
// Orchestrates the F3a resume review: load the seeker's parsedProfile, run the
// Gemma review (review-resume.js), and persist it on the user doc. Synchronous —
// the review is a single Gemma call on already-structured text (~5-10s, R5).
// The review is a pure profile-only review (no pool/market data) so it ships and
// runs standalone. Cache invalidation is implicit: a new profile upsert bumps
// profileUpdatedAt past profileReviewedAt, letting F3c flag a stale review.

import { HttpError } from '../../middleware/error-handler-middleware.js';
import { getGemmaClient } from '../../gemma/gemma-runtime.js';
import { reviewParsedProfile } from '../../gemma/review-resume.js';
import {
  getProfileForUser, getReviewForUser, upsertReviewForUser,
} from '../../models/seeker/seeker-profile-helpers.js';

/** Run a fresh review for the user, persist it, and return it. */
export async function runResumeReviewForUser(userId) {
  const parsedProfile = await getProfileForUser(userId);
  if (!parsedProfile) {
    throw new HttpError(400, 'Upload a resume before requesting a review.', 'NO_PROFILE');
  }
  const client = getGemmaClient();
  if (!client) {
    throw new HttpError(503, 'Resume review is temporarily unavailable.', 'GEMMA_UNAVAILABLE');
  }

  let review;
  try {
    review = await reviewParsedProfile(parsedProfile, client);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(422, 'Could not review the resume. Please try again.', 'REVIEW_PARSE_FAILED');
  }

  await upsertReviewForUser(userId, review);
  return review;
}

/** Return the cached review for the user, or null when none has run. */
export async function getResumeReviewForUser(userId) {
  return getReviewForUser(userId);
}

export default runResumeReviewForUser;

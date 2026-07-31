// FILE: src/models/public/assignment-review-model.js
// assignment_reviews collection — one employer verdict per assignment submission.
// Lives beside assignment-submission-model.js (employer-authored, but hangs off an
// application, so models/public/ — same reasoning as applicant-note-model.js).
//
// Concurrency: reviewedAt doubles as the lock version. Every write returns an
// explicit { review, conflict } so a caller never has to re-read to find out what
// happened, and a second reviewer can never silently overwrite the first.

import { ObjectId } from 'mongodb';
import { col } from '../../Db/connection.js';

const reviewsCol = () => col('assignment_reviews');

const DUPLICATE_KEY_CODE = 11000;

export const MIN_OVERALL_SCORE = 1;
export const MAX_OVERALL_SCORE = 5;

/** Accept a string or ObjectId; return an ObjectId or null. */
function toOid(id) {
  if (id instanceof ObjectId) return id;
  if (typeof id === 'string' && ObjectId.isValid(id)) return new ObjectId(id);
  return null;
}

/** Idempotent index setup. Called on boot. */
export async function ensureAssignmentReviewIndexes() {
  const collection = await reviewsCol();
  // One review per submission — this uniqueness is what the E11000 path below leans on.
  await collection.createIndex(
    { assignmentSubmissionId: 1 },
    { unique: true, name: 'assignment_reviews_assignmentSubmissionId' },
  );
  await collection.createIndex({ companyId: 1 }, { name: 'assignment_reviews_companyId' });
}

/** Integer within [1,5] or throw. Rejects 3.5 and '3' — no coercion. */
function requireOverallScore(value) {
  if (!Number.isInteger(value) || value < MIN_OVERALL_SCORE || value > MAX_OVERALL_SCORE) {
    throw new Error(
      `assignment_review: overallScore must be an integer between ${MIN_OVERALL_SCORE} and ${MAX_OVERALL_SCORE}`,
    );
  }
  return value;
}

/** Re-read the stored review and report it as the losing side of a race. */
async function conflictWithStored(collection, companyOid, submissionOid) {
  const review = await collection.findOne({ companyId: companyOid, assignmentSubmissionId: submissionOid });
  return { review, conflict: true };
}

/**
 * Create or replace the review for one submission under an optimistic lock.
 *
 *   { review, conflict: false }  — the write landed
 *   { review, conflict: true }   — someone got there first; review is the CURRENT stored one
 *
 * expectedReviewedAt === null means "I believe there is no review yet": the filter
 * pins reviewedAt:null so an existing review can never be matched and clobbered;
 * the upsert then collides on the unique index. MongoDB only auto-retries a failed
 * upsert when the match condition's field set exactly equals the unique key pattern
 * — here it is {companyId, assignmentSubmissionId, reviewedAt} against an index on
 * {assignmentSubmissionId} alone, so the server will NOT retry and the E11000
 * reaches us. We catch it, re-read, and report the conflict.
 *
 * A Date expectedReviewedAt goes into the filter instead: no match means the stored
 * reviewedAt moved under us, which is the same conflict by a different route.
 */
export async function upsertAssignmentReview(
  companyId, assignmentSubmissionId, data = {}, { expectedReviewedAt = null, session } = {},
) {
  const companyOid = toOid(companyId);
  const submissionOid = toOid(assignmentSubmissionId);
  if (!companyOid) throw new Error('upsertAssignmentReview: invalid companyId');
  if (!submissionOid) throw new Error('upsertAssignmentReview: invalid assignmentSubmissionId');

  const reviewedAt = new Date();
  const setOps = {
    reviewedByEmployerUserId: toOid(data.reviewedByEmployerUserId),
    reviewedAt,
    overallScore: requireOverallScore(data.overallScore),
    passesBar: Boolean(data.passesBar),
    reviewNotesMarkdown: data.reviewNotesMarkdown ?? null,
  };

  const collection = await reviewsCol();
  const isFirstReview = expectedReviewedAt === null;
  const filter = {
    companyId: companyOid,
    assignmentSubmissionId: submissionOid,
    reviewedAt: isFirstReview ? null : expectedReviewedAt,
  };

  try {
    const review = await collection.findOneAndUpdate(
      filter,
      { $set: setOps, $setOnInsert: { companyId: companyOid, assignmentSubmissionId: submissionOid } },
      { upsert: isFirstReview, returnDocument: 'after', session },
    );
    if (!review) return conflictWithStored(collection, companyOid, submissionOid);
    return { review, conflict: false };
  } catch (err) {
    if (err?.code !== DUPLICATE_KEY_CODE) throw err;
    // Another reviewer's first review landed between our filter miss and our insert.
    return conflictWithStored(collection, companyOid, submissionOid);
  }
}

/** The review for one submission, scoped to the company — cross-tenant returns null. */
export async function getAssignmentReviewForSubmission(companyId, assignmentSubmissionId) {
  const companyOid = toOid(companyId);
  const submissionOid = toOid(assignmentSubmissionId);
  if (!companyOid || !submissionOid) return null;
  const collection = await reviewsCol();
  return collection.findOne({ companyId: companyOid, assignmentSubmissionId: submissionOid });
}

/**
 * Batch-fetch reviews for a page of submissions: tenant-scoped and bounded by an
 * explicit id list. An empty list returns [] without a query.
 */
export async function listAssignmentReviewsForSubmissions(companyId, submissionIds = []) {
  const companyOid = toOid(companyId);
  if (!companyOid) return [];
  const submissionOids = (Array.isArray(submissionIds) ? submissionIds : []).map(toOid).filter(Boolean);
  if (submissionOids.length === 0) return [];
  const collection = await reviewsCol();
  return collection
    .find({ companyId: companyOid, assignmentSubmissionId: { $in: submissionOids } })
    .toArray();
}

/** Client-safe projection — ids as strings. */
export function toPublicAssignmentReview(doc) {
  if (!doc) return null;
  return {
    id: doc._id.toString(),
    assignmentSubmissionId: doc.assignmentSubmissionId?.toString() ?? null,
    reviewedByEmployerUserId: doc.reviewedByEmployerUserId?.toString() ?? null,
    reviewedAt: doc.reviewedAt ?? null,
    overallScore: doc.overallScore ?? null,
    passesBar: Boolean(doc.passesBar),
    reviewNotesMarkdown: doc.reviewNotesMarkdown ?? null,
  };
}

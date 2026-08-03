// FILE: src/services/admin/assignment-analytics-service.js
// Take-home feature health, computed from MONGO — not PostHog.
//
// WHY THIS IS NOT A HOGQL QUERY. "How many postings have an assignment", "how many
// assignments exist", "how long from submission to review", "how many links does a
// typical submission carry" are all facts about rows we own. They have never been
// sent to PostHog as events and never should be — they are state, not behaviour.
// Only the two abandonment ratios are behavioural, and those live in
// analytics-queries.js. Do not try to answer a Mongo question with HogQL.
//
// Consequently this module has NO PostHog dependency and works whether or not
// POSTHOG_PERSONAL_API_KEY is set. That is deliberate: the admin page must still
// show the feature's shape when the analytics key is missing.
//
// Every pipeline is $match-first so the index does the narrowing before any $group.

import { col } from '../../Db/connection.js';

const NATIVE = 'native';
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Median of a numeric array. Returns null for an empty input rather than NaN — a
 * dashboard showing "NaN hours" is worse than one showing "—", and 0 would be a
 * lie (it reads as "instant", not "no data").
 *
 * Computed in Node rather than with $percentile so this keeps working on the
 * MongoDB 5.x deployments $percentile is not available on.
 */
export function median(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  // Even count averages the two middle values — the standard definition, and the
  // reason this is not just sorted[middle].
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

/** Round to one decimal so an hours figure reads sensibly. Null passes through. */
function round1(value) {
  return value == null ? null : Math.round(value * 10) / 10;
}

/**
 * Postings that currently require a take-home.
 *
 * The `source: 'native'` clause is NOT optional: the jobs collection is shared with
 * scraped ATS rows, the assignmentId index is partial on source, and omitting it
 * degrades the count into a collection scan AND would count scraped jobs that can
 * never have an assignment.
 */
async function countPostingsWithAssignments() {
  const jobs = await col('jobs');
  return jobs.countDocuments({ source: NATIVE, assignmentId: { $type: 'objectId' } });
}

/** Live assignments across all company libraries. Archived rows are excluded. */
async function countActiveAssignments() {
  const assignments = await col('assignments');
  return assignments.countDocuments({ archivedAt: null });
}

async function countSince(collectionName, field, since) {
  const collection = await col(collectionName);
  return collection.countDocuments({ [field]: { $gte: since } });
}

/**
 * Median hours from submission to its review. Only submissions that HAVE a review
 * contribute — an unreviewed submission has no elapsed time yet, and treating it as
 * zero or as "now minus submittedAt" would both distort the number.
 */
async function medianSubmissionToReviewHours() {
  const submissions = await col('assignment_submissions');
  const rows = await submissions.aggregate([
    { $match: { submittedAt: { $type: 'date' } } },
    {
      $lookup: {
        from: 'assignment_reviews',
        localField: '_id',
        foreignField: 'assignmentSubmissionId',
        as: 'review',
      },
    },
    { $addFields: { reviewedAt: { $first: '$review.reviewedAt' } } },
    { $match: { reviewedAt: { $type: 'date' } } },
    { $project: { hours: { $divide: [{ $subtract: ['$reviewedAt', '$submittedAt'] }, 3_600_000] } } },
  ]).toArray();
  return round1(median(rows.map((row) => row.hours)));
}

/** Median links and files per submission, over every submission ever made. */
async function medianSubmissionShape() {
  const submissions = await col('assignment_submissions');
  const rows = await submissions.aggregate([
    { $match: {} },
    {
      $project: {
        // A submission whose files were deleted for DPDP keeps its row but loses
        // the array, so $size on a missing field must not throw.
        linkCount: { $size: { $ifNull: ['$links', []] } },
        fileCount: { $size: { $ifNull: ['$files', []] } },
      },
    },
  ]).toArray();
  return {
    medianLinksPerSubmission: median(rows.map((row) => row.linkCount)),
    medianFilesPerSubmission: median(rows.map((row) => row.fileCount)),
  };
}

/**
 * Every §5.1 Mongo-backed metric in one call. An empty database returns zeros and
 * nulls — never NaN, never a throw.
 */
export async function getAssignmentStats({ now = Date.now() } = {}) {
  const since = new Date(now - THIRTY_DAYS_MS);

  const [
    postingsWithAssignments,
    totalAssignments,
    submissionsLast30Days,
    reviewsLast30Days,
    medianReviewHours,
    shape,
  ] = await Promise.all([
    countPostingsWithAssignments(),
    countActiveAssignments(),
    countSince('assignment_submissions', 'submittedAt', since),
    countSince('assignment_reviews', 'reviewedAt', since),
    medianSubmissionToReviewHours(),
    medianSubmissionShape(),
  ]);

  return {
    postingsWithAssignments,
    totalAssignments,
    submissionsLast30Days,
    reviewsLast30Days,
    medianSubmissionToReviewHours: medianReviewHours,
    medianLinksPerSubmission: shape.medianLinksPerSubmission,
    medianFilesPerSubmission: shape.medianFilesPerSubmission,
    windowDays: 30,
  };
}

export default getAssignmentStats;

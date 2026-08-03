// FILE: tests/services/assignment-analytics-service.test.js
// Mongo-backed §5.1 stats. Every assertion is against seeded rows — this service has
// NO PostHog dependency and none is mocked, which is the point of it existing.
import { connectTestDb, closeTestDb, dropCollections } from '../_helpers/test-db.js';

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';

const { getAssignmentStats, median } = await import('../../src/services/admin/assignment-analytics-service.js');
const { col } = await import('../../src/Db/connection.js');

const COMPANY = new ObjectId();
const COLLECTIONS = ['assignment_submissions', 'assignment_reviews', 'jobs', 'assignments'];

const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

before(async () => { await connectTestDb(); });
after(async () => { await dropCollections(...COLLECTIONS); await closeTestDb(); });
beforeEach(async () => { await dropCollections(...COLLECTIONS); });

test('median averages the two middle values on an even count', () => {
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([4, 1, 3, 2]), 2.5); // unsorted input
  assert.equal(median([1, 2, 3]), 2);
  assert.equal(median([7]), 7);
});

test('median returns null for an empty set — never NaN, never a misleading 0', () => {
  assert.equal(median([]), null);
  assert.equal(median([Number.NaN, undefined, null]), null);
});

test('an empty database returns zeros and nulls, never NaN', async () => {
  const stats = await getAssignmentStats();
  assert.equal(stats.postingsWithAssignments, 0);
  assert.equal(stats.totalAssignments, 0);
  assert.equal(stats.submissionsLast30Days, 0);
  assert.equal(stats.reviewsLast30Days, 0);
  assert.equal(stats.medianSubmissionToReviewHours, null);
  assert.equal(stats.medianLinksPerSubmission, null);
  assert.equal(stats.medianFilesPerSubmission, null);
  for (const value of Object.values(stats)) assert.ok(!Number.isNaN(value));
});

test('postingsWithAssignments counts only NATIVE jobs holding a real assignmentId', async () => {
  const jobs = await col('jobs');
  await jobs.insertMany([
    { source: 'native', companyId: COMPANY, assignmentId: new ObjectId() },
    { source: 'native', companyId: COMPANY, assignmentId: new ObjectId() },
    { source: 'native', companyId: COMPANY, assignmentId: null },       // attached to nothing
    // A scraped ATS row can never have an assignment; if one somehow carries the
    // field it must still not be counted.
    { source: 'scraped', companyId: COMPANY, assignmentId: new ObjectId() },
  ]);
  const stats = await getAssignmentStats();
  assert.equal(stats.postingsWithAssignments, 2);
});

test('totalAssignments excludes archived rows', async () => {
  const assignments = await col('assignments');
  await assignments.insertMany([
    { companyId: COMPANY, archivedAt: null },
    { companyId: COMPANY, archivedAt: null },
    { companyId: COMPANY, archivedAt: new Date() },
  ]);
  const stats = await getAssignmentStats();
  assert.equal(stats.totalAssignments, 2);
});

test('the 30-day counters exclude older rows', async () => {
  const submissions = await col('assignment_submissions');
  const reviews = await col('assignment_reviews');
  await submissions.insertMany([
    { companyId: COMPANY, submittedAt: daysAgo(1), links: [], files: [] },
    { companyId: COMPANY, submittedAt: daysAgo(29), links: [], files: [] },
    { companyId: COMPANY, submittedAt: daysAgo(40), links: [], files: [] },
  ]);
  await reviews.insertMany([
    { companyId: COMPANY, reviewedAt: daysAgo(2) },
    { companyId: COMPANY, reviewedAt: daysAgo(90) },
  ]);
  const stats = await getAssignmentStats();
  assert.equal(stats.submissionsLast30Days, 2);
  assert.equal(stats.reviewsLast30Days, 1);
  assert.equal(stats.windowDays, 30);
});

test('medianSubmissionToReviewHours measures submittedAt → reviewedAt', async () => {
  const submissions = await col('assignment_submissions');
  const reviews = await col('assignment_reviews');
  const base = new Date('2026-08-01T00:00:00.000Z');
  const ids = [new ObjectId(), new ObjectId(), new ObjectId()];
  await submissions.insertMany(ids.map((id) => ({
    _id: id, companyId: COMPANY, submittedAt: base, links: [], files: [],
  })));
  // 2h, 4h, 12h → median 4
  await reviews.insertMany([
    { companyId: COMPANY, assignmentSubmissionId: ids[0], reviewedAt: new Date(base.getTime() + 2 * 3_600_000) },
    { companyId: COMPANY, assignmentSubmissionId: ids[1], reviewedAt: new Date(base.getTime() + 4 * 3_600_000) },
    { companyId: COMPANY, assignmentSubmissionId: ids[2], reviewedAt: new Date(base.getTime() + 12 * 3_600_000) },
  ]);
  const stats = await getAssignmentStats();
  assert.equal(stats.medianSubmissionToReviewHours, 4);
});

test('an UNREVIEWED submission contributes nothing to the review-time median', async () => {
  const submissions = await col('assignment_submissions');
  const reviews = await col('assignment_reviews');
  const base = new Date('2026-08-01T00:00:00.000Z');
  const reviewed = new ObjectId();
  await submissions.insertMany([
    { _id: reviewed, companyId: COMPANY, submittedAt: base, links: [], files: [] },
    { _id: new ObjectId(), companyId: COMPANY, submittedAt: base, links: [], files: [] },
  ]);
  await reviews.insertOne({
    companyId: COMPANY, assignmentSubmissionId: reviewed, reviewedAt: new Date(base.getTime() + 6 * 3_600_000),
  });
  const stats = await getAssignmentStats();
  // 6, not 3 — the unreviewed row is absent, not counted as zero.
  assert.equal(stats.medianSubmissionToReviewHours, 6);
});

test('median links and files per submission', async () => {
  const submissions = await col('assignment_submissions');
  await submissions.insertMany([
    { companyId: COMPANY, submittedAt: daysAgo(1), links: [{ url: 'a' }], files: [] },
    { companyId: COMPANY, submittedAt: daysAgo(1), links: [{ url: 'a' }, { url: 'b' }], files: [{ fileId: '1' }] },
    { companyId: COMPANY, submittedAt: daysAgo(1), links: [{ url: 'a' }, { url: 'b' }, { url: 'c' }], files: [{ fileId: '1' }, { fileId: '2' }] },
  ]);
  const stats = await getAssignmentStats();
  assert.equal(stats.medianLinksPerSubmission, 2);
  assert.equal(stats.medianFilesPerSubmission, 1);
});

test('a DPDP-erased submission (no files array) does not break the shape median', async () => {
  const submissions = await col('assignment_submissions');
  await submissions.insertMany([
    { companyId: COMPANY, submittedAt: daysAgo(1), filesDeletedAt: new Date() }, // no links/files keys at all
    { companyId: COMPANY, submittedAt: daysAgo(1), links: [{ url: 'a' }, { url: 'b' }], files: [{ fileId: '1' }] },
  ]);
  const stats = await getAssignmentStats();
  assert.equal(stats.medianLinksPerSubmission, 1); // median of [0, 2]
  assert.equal(stats.medianFilesPerSubmission, 0.5); // median of [0, 1]
});

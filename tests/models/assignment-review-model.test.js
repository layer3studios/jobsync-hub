// FILE: tests/models/assignment-review-model.test.js
import './../_helpers/test-db.js';
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';

import { connectTestDb, dropCollections, closeTestDb } from '../_helpers/test-db.js';
import { col } from '../../src/Db/connection.js';
import {
  ensureAssignmentReviewIndexes, upsertAssignmentReview,
  getAssignmentReviewForSubmission, listAssignmentReviewsForSubmissions,
  toPublicAssignmentReview,
} from '../../src/models/public/assignment-review-model.js';

const companyA = new ObjectId();
const companyB = new ObjectId();

function review(overrides = {}) {
  return {
    reviewedByEmployerUserId: new ObjectId(), overallScore: 4,
    passesBar: true, reviewNotesMarkdown: 'Solid work.', ...overrides,
  };
}

before(async () => { await reset(); });
beforeEach(async () => { await reset(); });
after(async () => { await closeTestDb(); });
async function reset() {
  await dropCollections('assignment_reviews');
  await ensureAssignmentReviewIndexes();
}

test('ensureAssignmentReviewIndexes creates both expected indexes', async () => {
  const db = await connectTestDb();
  const names = (await db.collection('assignment_reviews').indexes()).map((i) => i.name);
  assert.ok(names.includes('assignment_reviews_assignmentSubmissionId'));
  assert.ok(names.includes('assignment_reviews_companyId'));
});

test('the first review inserts and reports conflict: false', async () => {
  const submissionId = new ObjectId();
  const { review: stored, conflict } = await upsertAssignmentReview(companyA, submissionId, review());
  assert.equal(conflict, false);
  assert.equal(stored.overallScore, 4);
  assert.equal(stored.passesBar, true);
  assert.equal(stored.companyId.toString(), companyA.toString());
  assert.equal(stored.assignmentSubmissionId.toString(), submissionId.toString());
  assert.ok(stored.reviewedAt instanceof Date);
  assert.equal(toPublicAssignmentReview(stored).id, stored._id.toString());
});

test('overallScore 0, 6 and 3.5 all throw', async () => {
  const submissionId = new ObjectId();
  for (const bad of [0, 6, 3.5, '4']) {
    await assert.rejects(
      () => upsertAssignmentReview(companyA, submissionId, review({ overallScore: bad })),
      `expected ${bad} to throw`,
    );
  }
});

test('LOCK: a stale expectedReviewedAt conflicts and leaves the stored review untouched', async () => {
  const submissionId = new ObjectId();
  const first = await upsertAssignmentReview(companyA, submissionId, review({ overallScore: 4 }));
  const staleStamp = new Date(first.review.reviewedAt.getTime() - 1000);

  const result = await upsertAssignmentReview(
    companyA, submissionId, review({ overallScore: 1, passesBar: false }),
    { expectedReviewedAt: staleStamp },
  );
  assert.equal(result.conflict, true);
  assert.equal(result.review.overallScore, 4);
  assert.equal(result.review.passesBar, true);
  assert.equal(result.review.reviewedAt.getTime(), first.review.reviewedAt.getTime());
});

test('LOCK: the current expectedReviewedAt wins — values update and reviewedAt advances', async () => {
  const submissionId = new ObjectId();
  const first = await upsertAssignmentReview(companyA, submissionId, review({ overallScore: 4 }));
  const second = await upsertAssignmentReview(
    companyA, submissionId, review({ overallScore: 2, passesBar: false, reviewNotesMarkdown: 'On reflection, no.' }),
    { expectedReviewedAt: first.review.reviewedAt },
  );
  assert.equal(second.conflict, false);
  assert.equal(second.review.overallScore, 2);
  assert.equal(second.review.passesBar, false);
  assert.equal(second.review.reviewNotesMarkdown, 'On reflection, no.');
  assert.ok(second.review.reviewedAt.getTime() >= first.review.reviewedAt.getTime());
  assert.equal(second.review._id.toString(), first.review._id.toString());
});

test('E11000 PATH: a first-review upsert against an already-reviewed submission resolves to conflict, not a throw', async () => {
  const submissionId = new ObjectId();
  const reviews = await col('assignment_reviews');
  const existingReviewedAt = new Date();
  await reviews.insertOne({
    companyId: companyA, assignmentSubmissionId: submissionId,
    reviewedByEmployerUserId: new ObjectId(), reviewedAt: existingReviewedAt,
    overallScore: 5, passesBar: true, reviewNotesMarkdown: 'Already done.',
  });

  const result = await upsertAssignmentReview(
    companyA, submissionId, review({ overallScore: 1, passesBar: false }), { expectedReviewedAt: null },
  );
  assert.equal(result.conflict, true);
  assert.equal(result.review.overallScore, 5);          // the stored review, not ours
  assert.equal(result.review.reviewNotesMarkdown, 'Already done.');
  assert.equal(result.review.reviewedAt.getTime(), existingReviewedAt.getTime());
});

test('cross-tenant: getAssignmentReviewForSubmission with another company returns null', async () => {
  const submissionId = new ObjectId();
  await upsertAssignmentReview(companyA, submissionId, review());
  assert.ok(await getAssignmentReviewForSubmission(companyA, submissionId));
  assert.equal(await getAssignmentReviewForSubmission(companyB, submissionId), null);
  assert.equal(await getAssignmentReviewForSubmission(companyA, 'not-an-id'), null);
});

test('listAssignmentReviewsForSubmissions: [] for an empty list, filtered by companyId', async () => {
  const subA = new ObjectId();
  const subB = new ObjectId();
  await upsertAssignmentReview(companyA, subA, review());
  await upsertAssignmentReview(companyB, subB, review());
  assert.deepEqual(await listAssignmentReviewsForSubmissions(companyA, []), []);
  const mine = await listAssignmentReviewsForSubmissions(companyA, [subA, subB]);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].assignmentSubmissionId.toString(), subA.toString());
});

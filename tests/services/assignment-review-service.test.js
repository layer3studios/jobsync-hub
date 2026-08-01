// FILE: tests/services/assignment-review-service.test.js
import './../_helpers/test-db.js';
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';

import { dropCollections, closeTestDb } from '../_helpers/test-db.js';
import { col } from '../../src/Db/connection.js';
import {
  submitAssignmentReview, getAssignmentReviewFor,
} from '../../src/services/employer/assignment-review-service.js';
import { ensureAssignmentReviewIndexes } from '../../src/models/public/assignment-review-model.js';
import {
  ensureEmployerUserIndexes, findOrCreateEmployerGoogleUser,
} from '../../src/models/employer/employer-user-model.js';

const companyA = new ObjectId();
const submission = { _id: new ObjectId() };

function rejects(fn, code) {
  return assert.rejects(fn, (err) => {
    assert.equal(err.status, 400, `expected status 400, got ${err.status}`);
    assert.equal(err.code, code, `expected code ${code}, got ${err.code}`);
    return true;
  });
}

const valid = (overrides = {}) => ({ overallScore: 4, passesBar: true, ...overrides });

let seq = 0;
async function seedReviewer(name) {
  seq += 1;
  return findOrCreateEmployerGoogleUser({
    googleId: `g-rev-${seq}`, email: `${name.toLowerCase()}${seq}@acme.com`, name, picture: null,
  });
}

before(async () => { await reset(); });
beforeEach(async () => { await reset(); });
after(async () => { await closeTestDb(); });
async function reset() {
  await dropCollections('assignment_reviews', 'employer_users');
  await ensureAssignmentReviewIndexes();
  await ensureEmployerUserIndexes();
  submission._id = new ObjectId();
}

test('overallScore 0, 6, 3.5 and "4" → INVALID_OVERALL_SCORE', async () => {
  for (const bad of [0, 6, 3.5, '4', null, undefined, NaN]) {
    await rejects(
      () => submitAssignmentReview(companyA, submission, new ObjectId(), valid({ overallScore: bad })),
      'INVALID_OVERALL_SCORE',
    );
  }
});

test('passesBar as the STRING "true" → INVALID_PASSES_BAR (never coerced)', async () => {
  for (const bad of ['true', 'false', 1, 0, null, undefined]) {
    await rejects(
      () => submitAssignmentReview(companyA, submission, new ObjectId(), valid({ passesBar: bad })),
      'INVALID_PASSES_BAR',
    );
  }
  // Real booleans are fine.
  const passing = await submitAssignmentReview(companyA, submission, new ObjectId(), valid({ passesBar: false }));
  assert.equal(passing.review.passesBar, false);
});

test('notes: control chars stripped BEFORE the length check; >5000 rejected', async () => {
  // 5000 real chars plus control padding must PASS.
  const padded = `${'x'.repeat(5000)}${'\x00'.repeat(40)}`;
  const ok = await submitAssignmentReview(companyA, submission, new ObjectId(), valid({ reviewNotesMarkdown: padded }));
  assert.equal(ok.review.reviewNotesMarkdown.length, 5000);

  await rejects(
    () => submitAssignmentReview(companyA, { _id: new ObjectId() }, new ObjectId(), valid({ reviewNotesMarkdown: 'x'.repeat(5001) })),
    'INVALID_NOTES',
  );
});

test('notes: <script> inside a fenced code block is ACCEPTED', async () => {
  const body = ['Their fix was:', '', '```html', '<script>alert(1)</script>', '```'].join('\n');
  const result = await submitAssignmentReview(companyA, submission, new ObjectId(), valid({ reviewNotesMarkdown: body }));
  assert.ok(result.review.reviewNotesMarkdown.includes('<script>'));
});

test('notes: absent → empty string', async () => {
  const result = await submitAssignmentReview(companyA, submission, new ObjectId(), valid());
  assert.equal(result.review.reviewNotesMarkdown, '');
});

test('an unparseable expectedReviewedAt → INVALID_EXPECTED_REVIEWED_AT', async () => {
  for (const bad of ['not-a-date', 'yesterday', 12345, {}]) {
    await rejects(
      () => submitAssignmentReview(companyA, submission, new ObjectId(), valid({ expectedReviewedAt: bad })),
      'INVALID_EXPECTED_REVIEWED_AT',
    );
  }
});

test('the first review → conflict false and no conflictingReviewer', async () => {
  const reviewer = await seedReviewer('Asha');
  const result = await submitAssignmentReview(companyA, submission, reviewer._id, valid({ overallScore: 5 }));
  assert.equal(result.conflict, false);
  assert.equal(result.conflictingReviewer, null);
  assert.equal(result.review.overallScore, 5);
  assert.equal(result.review.reviewedByEmployerUserId, reviewer._id.toString());
});

test('a STALE expectedReviewedAt → conflict true WITH the other reviewer named', async () => {
  const first = await seedReviewer('Rahul');
  const second = await seedReviewer('Meera');

  const original = await submitAssignmentReview(companyA, submission, first._id, valid({ overallScore: 5, reviewNotesMarkdown: 'Strong.' }));
  const stale = new Date(new Date(original.review.reviewedAt).getTime() - 1000);

  const result = await submitAssignmentReview(
    companyA, submission, second._id,
    valid({ overallScore: 1, passesBar: false }),
  );
  // (the call above uses expectedReviewedAt: undefined → first-review path, which
  //  also conflicts because a review already exists)
  assert.equal(result.conflict, true);
  assert.ok(result.conflictingReviewer, 'the losing reviewer must be told who won');
  assert.equal(result.conflictingReviewer.name, 'Rahul');
  assert.match(result.conflictingReviewer.email, /rahul/);

  // Explicit stale timestamp takes the same path.
  const withStale = await submitAssignmentReview(
    companyA, submission, second._id, valid({ overallScore: 1, expectedReviewedAt: stale.toISOString() }),
  );
  assert.equal(withStale.conflict, true);
  assert.equal(withStale.conflictingReviewer.name, 'Rahul');

  // The stored review is UNCHANGED.
  const stored = await getAssignmentReviewFor(companyA, submission._id);
  assert.equal(stored.overallScore, 5);
  assert.equal(stored.reviewNotesMarkdown, 'Strong.');
});

test('the CURRENT expectedReviewedAt wins — values update, reviewedAt advances', async () => {
  const reviewer = await seedReviewer('Sana');
  const first = await submitAssignmentReview(companyA, submission, reviewer._id, valid({ overallScore: 4 }));

  const second = await submitAssignmentReview(companyA, submission, reviewer._id, valid({
    overallScore: 2, passesBar: false, reviewNotesMarkdown: 'On reflection, no.',
    expectedReviewedAt: first.review.reviewedAt,
  }));
  assert.equal(second.conflict, false);
  assert.equal(second.review.overallScore, 2);
  assert.equal(second.review.passesBar, false);
  assert.ok(new Date(second.review.reviewedAt) >= new Date(first.review.reviewedAt));
});

test('conflictingReviewer is null when that employer user row no longer exists', async () => {
  const ghost = await seedReviewer('Ghost');
  await submitAssignmentReview(companyA, submission, ghost._id, valid());

  // The reviewer left and their user row was purged.
  const users = await col('employer_users');
  await users.deleteOne({ _id: ghost._id });

  const result = await submitAssignmentReview(companyA, submission, new ObjectId(), valid({ overallScore: 3 }));
  assert.equal(result.conflict, true);
  assert.equal(result.conflictingReviewer, null, 'a missing user row must degrade to null, not throw');
});

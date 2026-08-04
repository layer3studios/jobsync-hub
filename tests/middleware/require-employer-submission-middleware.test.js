// FILE: tests/middleware/require-employer-submission-middleware.test.js
import './../_helpers/test-db.js';
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';

import { dropCollections, closeTestDb } from '../_helpers/test-db.js';
import { requireEmployerSubmission } from '../../src/middleware/require-employer-submission-middleware.js';
import {
  ensureAssignmentSubmissionIndexes, insertAssignmentSubmission,
} from '../../src/models/public/assignment-submission-model.js';

const companyA = new ObjectId();
const companyB = new ObjectId();

/** Run the middleware and capture whether next() got an error. */
async function run(companyId, submissionId) {
  const req = { employerCompanyId: companyId, params: { submissionId: String(submissionId) } };
  let nextArg = 'NOT_CALLED';
  await requireEmployerSubmission(req, {}, (err) => { nextArg = err; });
  return { req, nextArg };
}

before(async () => { await reset(); });
beforeEach(async () => { await reset(); });
after(async () => { await closeTestDb(); });
async function reset() {
  await dropCollections('assignment_submissions');
  await ensureAssignmentSubmissionIndexes();
}

function seed(companyId) {
  return insertAssignmentSubmission({
    applicationId: new ObjectId(), companyId, jobId: new ObjectId(),
    links: [{ url: 'https://example.com/x', addedAt: new Date() }],
  });
}

test('an invalid ObjectId → 400 INVALID_SUBMISSION_ID', async () => {
  const { nextArg } = await run(companyA, 'not-an-id');
  assert.equal(nextArg.status, 400);
  assert.equal(nextArg.code, 'INVALID_SUBMISSION_ID');
});

test('a cross-tenant submission → 404 SUBMISSION_NOT_FOUND, never 403', async () => {
  const submission = await seed(companyA);
  const { nextArg, req } = await run(companyB, submission._id);
  assert.equal(nextArg.status, 404);
  assert.equal(nextArg.code, 'SUBMISSION_NOT_FOUND');
  assert.notEqual(nextArg.status, 403, 'existence must never be revealed');
  assert.equal(req.assignmentSubmission, undefined);
});

test('a missing submission → 404 SUBMISSION_NOT_FOUND', async () => {
  const { nextArg } = await run(companyA, new ObjectId());
  assert.equal(nextArg.status, 404);
  assert.equal(nextArg.code, 'SUBMISSION_NOT_FOUND');
});

test('a valid submission → next() with no error and req.assignmentSubmission attached', async () => {
  const submission = await seed(companyA);
  const { nextArg, req } = await run(companyA, submission._id);
  assert.equal(nextArg, undefined, 'next() must be called with no argument');
  assert.ok(req.assignmentSubmission);
  assert.equal(req.assignmentSubmission._id.toString(), submission._id.toString());
  assert.equal(req.assignmentSubmission.companyId.toString(), companyA.toString());
});

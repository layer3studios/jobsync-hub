// FILE: tests/api/employer-assignment-reviews-routes.test.js
import './../_helpers/test-db.js';
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { ObjectId } from 'mongodb';

import { dropCollections, closeTestDb } from '../_helpers/test-db.js';
import { col } from '../../src/Db/connection.js';
import { EMPLOYER_JWT_SECRET } from '../../src/env.js';
import { errorHandler } from '../../src/middleware/error-handler-middleware.js';
import { requireEmployer } from '../../src/middleware/require-employer-middleware.js';
import { requireEmployerCompany } from '../../src/middleware/require-employer-company-middleware.js';
import employerAssignmentReviewsRouter from '../../src/api/employer/employer-assignment-reviews-routes.js';
import {
  ensureCompanyIndexes, ensureEmployerUserIndexes, ensureCompanyMemberIndexes,
  findOrCreateEmployerGoogleUser, createCompany, linkCompanyToEmployerUser, insertCompanyMember,
} from '../../src/models/employer/index.js';
import {
  ensureAssignmentSubmissionIndexes, insertAssignmentSubmission,
} from '../../src/models/public/assignment-submission-model.js';
import { ensureAssignmentReviewIndexes } from '../../src/models/public/assignment-review-model.js';
import { verifyAssignmentFileToken } from '../../src/services/employer/assignment-signed-url-service.js';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/employer/assignment-reviews', requireEmployer, requireEmployerCompany, employerAssignmentReviewsRouter);
  app.use(errorHandler);
  return app;
}

let seq = 0;
async function onboardedCookie(tag) {
  const user = await findOrCreateEmployerGoogleUser({ googleId: `g-${tag}`, email: `o${tag}@acme.com`, name: `Owner ${tag}`, picture: null });
  const company = await createCompany({ name: `Acme ${tag}` }, user._id);
  await linkCompanyToEmployerUser(user._id, company._id);
  await insertCompanyMember({ companyId: company._id, employerUserId: user._id, role: 'founder', isFounder: true });
  const token = jwt.sign({ employerUserId: user._id.toString(), email: user.email }, EMPLOYER_JWT_SECRET);
  return { cookie: `jm_employer_token=${token}`, company, user };
}

async function addRoleCookie(companyId, role, { withMembership = true } = {}) {
  seq += 1;
  const user = await findOrCreateEmployerGoogleUser({ googleId: `gr-${role}-${seq}`, email: `r${role}${seq}@acme.com`, name: `${role} ${seq}`, picture: null });
  await linkCompanyToEmployerUser(user._id, companyId);
  if (withMembership) await insertCompanyMember({ companyId, employerUserId: user._id, role, isFounder: false });
  return { cookie: `jm_employer_token=${jwt.sign({ employerUserId: user._id.toString(), email: user.email }, EMPLOYER_JWT_SECRET)}`, user };
}

const FILE = {
  fileId: 'aaaaaaaa-1111-2222-3333-444444444444',
  originalName: 'answer.pdf',
  storagePath: 'data/assignment-submissions/aaaaaaaa-1111-2222-3333-444444444444.pdf',
  sizeBytes: 2048, mimeType: 'application/pdf', uploadedAt: new Date(),
};

function seedSubmission(companyId, overrides = {}) {
  return insertAssignmentSubmission({
    applicationId: new ObjectId(), companyId, jobId: new ObjectId(),
    links: [{ url: 'https://github.com/me/solution', addedAt: new Date() }],
    files: [FILE], seekerNotesMarkdown: 'Done.', ...overrides,
  });
}

const putReview = (app, cookie, submissionId, body) => request(app)
  .put(`/api/employer/assignment-reviews/${submissionId}`).set('Cookie', cookie).send(body);
const getReview = (app, cookie, submissionId) => request(app)
  .get(`/api/employer/assignment-reviews/${submissionId}`).set('Cookie', cookie);

before(async () => { await reset(); });
beforeEach(async () => { await reset(); });
after(async () => { await closeTestDb(); });
async function reset() {
  await dropCollections('assignment_submissions', 'assignment_reviews', 'companies', 'company_members', 'employer_users');
  await ensureCompanyIndexes(); await ensureEmployerUserIndexes(); await ensureCompanyMemberIndexes();
  await ensureAssignmentSubmissionIndexes(); await ensureAssignmentReviewIndexes();
}

test('PUT creates the first review → 200 and a stored row', async () => {
  const { cookie, company } = await onboardedCookie('a');
  const submission = await seedSubmission(company._id);
  const app = buildApp();

  const res = await putReview(app, cookie, submission._id, {
    overallScore: 4, passesBar: true, reviewNotesMarkdown: 'Clean solution.',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.review.overallScore, 4);
  assert.equal(res.body.review.passesBar, true);
  assert.ok(res.body.review.reviewedAt);

  const reviews = await col('assignment_reviews');
  assert.equal(await reviews.countDocuments({}), 1);
});

test('GET returns the review, and null when there is none', async () => {
  const { cookie, company } = await onboardedCookie('b');
  const submission = await seedSubmission(company._id);
  const app = buildApp();

  assert.equal((await getReview(app, cookie, submission._id)).body.review, null);
  await putReview(app, cookie, submission._id, { overallScore: 3, passesBar: false });
  const res = await getReview(app, cookie, submission._id);
  assert.equal(res.status, 200);
  assert.equal(res.body.review.overallScore, 3);
});

test('PUT with the CURRENT reviewedAt → 200, values updated, reviewedAt advanced', async () => {
  const { cookie, company } = await onboardedCookie('c');
  const submission = await seedSubmission(company._id);
  const app = buildApp();

  const first = await putReview(app, cookie, submission._id, { overallScore: 4, passesBar: true });
  const res = await putReview(app, cookie, submission._id, {
    overallScore: 2, passesBar: false, expectedReviewedAt: first.body.review.reviewedAt,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.review.overallScore, 2);
  assert.equal(res.body.review.passesBar, false);
  assert.ok(new Date(res.body.review.reviewedAt) >= new Date(first.body.review.reviewedAt));
});

test('PUT with a STALE reviewedAt → 409 REVIEW_CONFLICT carrying the full current review', async () => {
  const { cookie, company } = await onboardedCookie('d');
  const submission = await seedSubmission(company._id);
  const app = buildApp();
  const other = await addRoleCookie(company._id, 'member');

  const first = await putReview(app, cookie, submission._id, {
    overallScore: 5, passesBar: true, reviewNotesMarkdown: 'Excellent work.',
  });
  const stale = new Date(new Date(first.body.review.reviewedAt).getTime() - 5000).toISOString();

  const res = await putReview(app, other.cookie, submission._id, {
    overallScore: 1, passesBar: false, reviewNotesMarkdown: 'Disagree.', expectedReviewedAt: stale,
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'REVIEW_CONFLICT');
  assert.match(res.body.error, /Another reviewer/);

  // The full winning review, not just a code — the client shows both side by side.
  assert.equal(res.body.currentReview.overallScore, 5);
  assert.equal(res.body.currentReview.passesBar, true);
  assert.equal(res.body.currentReview.reviewNotesMarkdown, 'Excellent work.');
  assert.ok(res.body.currentReview.reviewedAt);
  assert.equal(res.body.conflictingReviewer.name, 'Owner d');
  assert.match(res.body.conflictingReviewer.email, /od@acme.com/);

  // The STORED review is untouched.
  const reviews = await col('assignment_reviews');
  const stored = await reviews.findOne({ assignmentSubmissionId: submission._id });
  assert.equal(stored.overallScore, 5);
  assert.equal(stored.reviewNotesMarkdown, 'Excellent work.');
  assert.equal(await reviews.countDocuments({}), 1);
});

test('OVERRIDE: after a 409, re-PUT with the reviewedAt from the 409 body → 200', async () => {
  const { cookie, company } = await onboardedCookie('e');
  const submission = await seedSubmission(company._id);
  const app = buildApp();
  const other = await addRoleCookie(company._id, 'member');

  const first = await putReview(app, cookie, submission._id, { overallScore: 5, passesBar: true });
  const stale = new Date(new Date(first.body.review.reviewedAt).getTime() - 5000).toISOString();
  const conflict = await putReview(app, other.cookie, submission._id, {
    overallScore: 1, passesBar: false, expectedReviewedAt: stale,
  });
  assert.equal(conflict.status, 409);

  // The version IS the intent — no force flag needed.
  const override = await putReview(app, other.cookie, submission._id, {
    overallScore: 1, passesBar: false, reviewNotesMarkdown: 'Overriding after discussion.',
    expectedReviewedAt: conflict.body.currentReview.reviewedAt,
  });
  assert.equal(override.status, 200);
  assert.equal(override.body.review.overallScore, 1);
  assert.equal(override.body.review.passesBar, false);
});

test('a cross-tenant submissionId → 404 SUBMISSION_NOT_FOUND', async () => {
  const { company } = await onboardedCookie('f');
  const other = await onboardedCookie('f2');
  const submission = await seedSubmission(company._id);
  const app = buildApp();

  assert.equal((await getReview(app, other.cookie, submission._id)).status, 404);
  const res = await putReview(app, other.cookie, submission._id, { overallScore: 3, passesBar: true });
  assert.equal(res.status, 404);
  assert.equal(res.body.code, 'SUBMISSION_NOT_FOUND');
});

test('an unknown body key → 400 UNKNOWN_FIELD naming it', async () => {
  const { cookie, company } = await onboardedCookie('g');
  const submission = await seedSubmission(company._id);
  const res = await putReview(buildApp(), cookie, submission._id, {
    overallScore: 3, passesBar: true, reviewedByEmployerUserId: new ObjectId().toString(),
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'UNKNOWN_FIELD');
  assert.match(res.body.error, /reviewedByEmployerUserId/);
});

// ── Role gates — the correction this chunk exists to make ────────────────────
test('GATE: an INTERVIEWER can submit a review and mint a download URL', async () => {
  const { company } = await onboardedCookie('h');
  const submission = await seedSubmission(company._id);
  const app = buildApp();
  const interviewer = await addRoleCookie(company._id, 'interviewer');

  // An interviewer is on the team precisely to evaluate take-homes.
  const put = await putReview(app, interviewer.cookie, submission._id, { overallScore: 4, passesBar: true });
  assert.equal(put.status, 200);
  assert.equal((await getReview(app, interviewer.cookie, submission._id)).status, 200);

  const download = await request(app)
    .get(`/api/employer/assignment-reviews/${submission._id}/files/${FILE.fileId}/download-url`)
    .set('Cookie', interviewer.cookie);
  assert.equal(download.status, 200);
});

test('GATE: a MEMBER can submit a review', async () => {
  const { company } = await onboardedCookie('i');
  const submission = await seedSubmission(company._id);
  const member = await addRoleCookie(company._id, 'member');
  const res = await putReview(buildApp(), member.cookie, submission._id, { overallScore: 5, passesBar: true });
  assert.equal(res.status, 200);
});

test('GATE: a cookie with NO membership row → 403 COMPANY_MEMBERSHIP_NOT_FOUND', async () => {
  const { company } = await onboardedCookie('j');
  const submission = await seedSubmission(company._id);
  const stranger = await addRoleCookie(company._id, 'member', { withMembership: false });
  const res = await putReview(buildApp(), stranger.cookie, submission._id, { overallScore: 3, passesBar: true });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'COMPANY_MEMBERSHIP_NOT_FOUND');
});

// ── Download URL ─────────────────────────────────────────────────────────────
test('download-url: a valid fileId → a token verifying to the right storagePath', async () => {
  const { cookie, company } = await onboardedCookie('k');
  const submission = await seedSubmission(company._id);

  const res = await request(buildApp())
    .get(`/api/employer/assignment-reviews/${submission._id}/files/${FILE.fileId}/download-url`)
    .set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.body.url, /^\/api\/public\/assignment-download\?token=/);
  assert.ok(Date.parse(res.body.expiresAt) > Date.now());

  const token = new URL(res.body.url, 'http://x').searchParams.get('token');
  assert.equal(verifyAssignmentFileToken(token).storagePath, FILE.storagePath);
});

test('download-url: storagePath appears NOWHERE in the response body', async () => {
  const { cookie, company } = await onboardedCookie('l');
  const submission = await seedSubmission(company._id);
  const res = await request(buildApp())
    .get(`/api/employer/assignment-reviews/${submission._id}/files/${FILE.fileId}/download-url`)
    .set('Cookie', cookie);

  const serialized = JSON.stringify(res.body);
  assert.equal(serialized.includes(FILE.storagePath), false);
  assert.equal(serialized.includes('data/assignment-submissions'), false);
  assert.equal('storagePath' in res.body, false);
});

test('download-url: an unknown fileId → 404 FILE_NOT_FOUND', async () => {
  const { cookie, company } = await onboardedCookie('m');
  const submission = await seedSubmission(company._id);
  const res = await request(buildApp())
    .get(`/api/employer/assignment-reviews/${submission._id}/files/no-such-file/download-url`)
    .set('Cookie', cookie);
  assert.equal(res.status, 404);
  assert.equal(res.body.code, 'FILE_NOT_FOUND');
});

test('download-url: a tombstoned submission → 410 FILES_DELETED', async () => {
  const { cookie, company } = await onboardedCookie('n');
  const submission = await seedSubmission(company._id);
  const submissions = await col('assignment_submissions');
  await submissions.updateOne({ _id: submission._id }, { $set: { filesDeletedAt: new Date() } });

  const res = await request(buildApp())
    .get(`/api/employer/assignment-reviews/${submission._id}/files/${FILE.fileId}/download-url`)
    .set('Cookie', cookie);
  assert.equal(res.status, 410);
  assert.equal(res.body.code, 'FILES_DELETED');
});

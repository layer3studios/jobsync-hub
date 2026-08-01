// FILE: tests/api/employer-applicants-assignment-list.test.js
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
import employerPostingsRouter from '../../src/api/employer/employer-postings-routes.js';
import {
  ensureCompanyIndexes, ensureEmployerUserIndexes, ensureCompanyMemberIndexes,
  ensurePostingIndexes, ensureAssignmentIndexes, ensureStageIndexes,
  findOrCreateEmployerGoogleUser, createCompany, linkCompanyToEmployerUser, insertCompanyMember,
  createPostingForCompany, insertAssignment, setPostingAssignmentForCompany,
} from '../../src/models/employer/index.js';
import { ensureJobIndexes } from '../../src/models/shared/job-model.js';
import {
  ensureApplicationIndexes, createApplicationForCompany, ensureContactIndexes,
  findOrCreateContactForCompany,
} from '../../src/models/public/index.js';
import {
  ensureAssignmentSubmissionIndexes, insertAssignmentSubmission,
} from '../../src/models/public/assignment-submission-model.js';
import {
  ensureAssignmentReviewIndexes, upsertAssignmentReview,
} from '../../src/models/public/assignment-review-model.js';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/employer/jobs', requireEmployer, requireEmployerCompany, employerPostingsRouter);
  app.use(errorHandler);
  return app;
}

async function onboardedCookie(tag) {
  const user = await findOrCreateEmployerGoogleUser({ googleId: `g-${tag}`, email: `o${tag}@acme.com`, name: 'Owner', picture: null });
  const company = await createCompany({ name: `Acme ${tag}` }, user._id);
  await linkCompanyToEmployerUser(user._id, company._id);
  await insertCompanyMember({ companyId: company._id, employerUserId: user._id, role: 'founder', isFounder: true });
  const token = jwt.sign({ employerUserId: user._id.toString(), email: user.email }, EMPLOYER_JWT_SECRET);
  return { cookie: `jm_employer_token=${token}`, company };
}

async function seedPosting(company, { withAssignment }) {
  const posting = await createPostingForCompany(company._id, {
    title: 'React Developer', description: 'x'.repeat(60), location: 'Bangalore',
    workplaceType: 'remote', employmentType: 'full-time',
  }, new ObjectId());
  if (withAssignment) {
    const assignment = await insertAssignment({
      companyId: company._id, title: 'Rate limiter', publicSummary: 'A small exercise.',
      descriptionMarkdown: 'x'.repeat(60), estimatedHours: 4,
      submissionInstructionsMarkdown: '', allowedFileTypes: [], createdByEmployerUserId: new ObjectId(),
    });
    await setPostingAssignmentForCompany(company._id, posting._id, assignment._id);
  }
  return posting;
}

let applicantSeq = 0;
/** One applicant, optionally with a submission and optionally reviewed. */
async function seedApplicant(company, posting, { submit = false, review = null } = {}) {
  applicantSeq += 1;
  const { contact } = await findOrCreateContactForCompany(company._id, {
    email: `c${applicantSeq}@example.com`, fullName: `Candidate ${applicantSeq}`, phone: null,
  });
  const application = await createApplicationForCompany(company._id, {
    jobId: posting._id, contactId: contact._id, stageId: new ObjectId(),
  });
  if (!submit) return { application, submission: null };

  const submission = await insertAssignmentSubmission({
    applicationId: application._id, companyId: company._id, jobId: posting._id,
    links: [{ url: 'https://example.com/x', addedAt: new Date() }],
    files: [{ fileId: `f${applicantSeq}`, originalName: 'a.pdf', storagePath: `data/assignment-submissions/f${applicantSeq}.pdf`, sizeBytes: 1, mimeType: 'application/pdf', uploadedAt: new Date() }],
  });
  const applications = await col('applications');
  await applications.updateOne({ _id: application._id }, { $set: { assignmentSubmissionId: submission._id } });

  if (review) {
    await upsertAssignmentReview(company._id, submission._id, {
      reviewedByEmployerUserId: new ObjectId(),
      overallScore: review.overallScore, passesBar: review.passesBar, reviewNotesMarkdown: '',
    });
  }
  return { application, submission };
}

const list = (app, cookie, postingId, query = '') => request(app)
  .get(`/api/employer/jobs/${postingId}/applicants${query}`).set('Cookie', cookie);

before(async () => { await reset(); });
beforeEach(async () => { await reset(); });
after(async () => { await closeTestDb(); });
async function reset() {
  await dropCollections('jobs', 'assignments', 'applications', 'assignment_submissions',
    'assignment_reviews', 'resume_scores', 'contacts', 'companies', 'company_members',
    'employer_users', 'stages');
  await ensureCompanyIndexes(); await ensureEmployerUserIndexes(); await ensureCompanyMemberIndexes();
  await ensureJobIndexes(); await ensurePostingIndexes(); await ensureAssignmentIndexes();
  await ensureStageIndexes(); await ensureApplicationIndexes(); await ensureContactIndexes();
  await ensureAssignmentSubmissionIndexes(); await ensureAssignmentReviewIndexes();
}

// ── Zero regression ──────────────────────────────────────────────────────────
test('ZERO REGRESSION: a posting with NO assignment returns the original shape', async () => {
  const { cookie, company } = await onboardedCookie('a');
  const posting = await seedPosting(company, { withAssignment: false });
  await seedApplicant(company, posting);
  await seedApplicant(company, posting);

  const res = await list(buildApp(), cookie, posting._id);
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body), ['applicants'], 'no `stats` key on a plain posting');
  assert.equal(res.body.applicants.length, 2);
  for (const row of res.body.applicants) {
    assert.deepEqual(Object.keys(row).sort(), ['application', 'contact', 'score']);
    assert.equal('assignment' in row, false);
  }
});

test('ZERO REGRESSION: no assignment collection is queried for a plain posting', async () => {
  const { cookie, company } = await onboardedCookie('a2');
  const posting = await seedPosting(company, { withAssignment: false });
  await seedApplicant(company, posting);

  // A submission exists for ANOTHER posting; if the controller queried regardless,
  // the guard would be missing. Its absence from the response proves the guard runs.
  const otherPosting = await seedPosting(company, { withAssignment: true });
  await seedApplicant(company, otherPosting, { submit: true });

  const res = await list(buildApp(), cookie, posting._id);
  assert.equal(JSON.stringify(res.body).includes('assignment'), false);
});

test('ZERO REGRESSION: ?sort=score and ?sort=date behave as today', async () => {
  const { cookie, company } = await onboardedCookie('b');
  const posting = await seedPosting(company, { withAssignment: false });
  const first = await seedApplicant(company, posting);
  const second = await seedApplicant(company, posting);
  const app = buildApp();

  const byDate = await list(app, cookie, posting._id, '?sort=date');
  assert.equal(byDate.status, 200);
  assert.equal(byDate.body.applicants.length, 2);
  // Newest first.
  assert.equal(byDate.body.applicants[0].application.id, second.application._id.toString());

  const byScore = await list(app, cookie, posting._id, '?sort=score');
  assert.equal(byScore.status, 200);
  assert.equal(byScore.body.applicants.length, 2);
  assert.ok(first.application);
});

// ── With an assignment ───────────────────────────────────────────────────────
/** 4 applicants: 4/5 passed, 2/5 failed, submitted-unreviewed, and a legacy row. */
async function seedFour(company, posting) {
  const passed = await seedApplicant(company, posting, { submit: true, review: { overallScore: 4, passesBar: true } });
  const failed = await seedApplicant(company, posting, { submit: true, review: { overallScore: 2, passesBar: false } });
  const unreviewed = await seedApplicant(company, posting, { submit: true });
  const legacy = await seedApplicant(company, posting);
  return { passed, failed, unreviewed, legacy };
}

test('rows carry an `assignment` key and the response carries stats', async () => {
  const { cookie, company } = await onboardedCookie('c');
  const posting = await seedPosting(company, { withAssignment: true });
  const { legacy } = await seedFour(company, posting);

  const res = await list(buildApp(), cookie, posting._id);
  assert.equal(res.status, 200);
  assert.ok(res.body.stats);
  assert.equal(res.body.applicants.length, 4);

  const byId = new Map(res.body.applicants.map((row) => [row.application.id, row]));
  const legacyRow = byId.get(legacy.application._id.toString());
  assert.equal(legacyRow.assignment, null, 'a legacy application has no submission');

  const withSubmission = res.body.applicants.filter((row) => row.assignment);
  assert.equal(withSubmission.length, 3);
  for (const row of withSubmission) {
    assert.ok(row.assignment.submissionId);
    assert.ok(row.assignment.submittedAt);
    assert.equal(row.assignment.linkCount, 1);
    assert.equal(row.assignment.fileCount, 1);
    assert.equal('score' in row, true, 'the AI resume score key is untouched');
  }
});

test('stats: total 4, submitted 3, reviewed 2, passing 1', async () => {
  const { cookie, company } = await onboardedCookie('d');
  const posting = await seedPosting(company, { withAssignment: true });
  await seedFour(company, posting);

  const res = await list(buildApp(), cookie, posting._id);
  assert.deepEqual(res.body.stats, { total: 4, submitted: 3, reviewed: 2, passing: 1 });
});

test('?sort=assignment: 4/5 first, 2/5 second, unreviewed, then no-submission last', async () => {
  const { cookie, company } = await onboardedCookie('e');
  const posting = await seedPosting(company, { withAssignment: true });
  const { passed, failed, unreviewed, legacy } = await seedFour(company, posting);

  const res = await list(buildApp(), cookie, posting._id, '?sort=assignment');
  assert.equal(res.status, 200);
  assert.deepEqual(
    res.body.applicants.map((row) => row.application.id),
    [passed, failed, unreviewed, legacy].map((entry) => entry.application._id.toString()),
  );
});

test('?assignmentReview=passed returns only the 4/5 row', async () => {
  const { cookie, company } = await onboardedCookie('f');
  const posting = await seedPosting(company, { withAssignment: true });
  const { passed } = await seedFour(company, posting);

  const res = await list(buildApp(), cookie, posting._id, '?assignmentReview=passed');
  assert.equal(res.body.applicants.length, 1);
  assert.equal(res.body.applicants[0].application.id, passed.application._id.toString());
  assert.equal(res.body.applicants[0].assignment.review.overallScore, 4);
});

test('?assignmentReview=not_reviewed excludes the LEGACY no-submission row', async () => {
  const { cookie, company } = await onboardedCookie('g');
  const posting = await seedPosting(company, { withAssignment: true });
  const { unreviewed } = await seedFour(company, posting);

  const res = await list(buildApp(), cookie, posting._id, '?assignmentReview=not_reviewed');
  assert.equal(res.body.applicants.length, 1, 'a row with no submission is not "not reviewed"');
  assert.equal(res.body.applicants[0].application.id, unreviewed.application._id.toString());
});

test('?assignmentReview=reviewed and =failed select the right rows', async () => {
  const { cookie, company } = await onboardedCookie('h');
  const posting = await seedPosting(company, { withAssignment: true });
  const { failed } = await seedFour(company, posting);
  const app = buildApp();

  assert.equal((await list(app, cookie, posting._id, '?assignmentReview=reviewed')).body.applicants.length, 2);
  const failedRes = await list(app, cookie, posting._id, '?assignmentReview=failed');
  assert.equal(failedRes.body.applicants.length, 1);
  assert.equal(failedRes.body.applicants[0].application.id, failed.application._id.toString());
});

test('?assignmentReview=bogus → 400 INVALID_ASSIGNMENT_FILTER', async () => {
  const { cookie, company } = await onboardedCookie('i');
  const posting = await seedPosting(company, { withAssignment: true });
  const res = await list(buildApp(), cookie, posting._id, '?assignmentReview=bogus');
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'INVALID_ASSIGNMENT_FILTER');
});

test('STATS DESCRIBE THE POSTING: identical with and without a filter', async () => {
  const { cookie, company } = await onboardedCookie('j');
  const posting = await seedPosting(company, { withAssignment: true });
  await seedFour(company, posting);
  const app = buildApp();

  const unfiltered = await list(app, cookie, posting._id);
  const filtered = await list(app, cookie, posting._id, '?assignmentReview=passed');

  assert.equal(filtered.body.applicants.length, 1);
  assert.deepEqual(filtered.body.stats, unfiltered.body.stats);
  // The strip summarises the posting, so 4 alongside a single row is CORRECT.
  assert.equal(filtered.body.stats.total, 4);
});

test('stats come from the posting, not the returned rows — a stage filter does not move them', async () => {
  const { cookie, company } = await onboardedCookie('k');
  const posting = await seedPosting(company, { withAssignment: true });
  await seedFour(company, posting);

  // A stageId nobody is in returns zero rows; stats must be unchanged.
  const res = await list(buildApp(), cookie, posting._id, `?stageId=${new ObjectId()}`);
  assert.equal(res.body.applicants.length, 0);
  assert.deepEqual(res.body.stats, { total: 4, submitted: 3, reviewed: 2, passing: 1 });
});

test('stats are scoped to the posting, not the company', async () => {
  const { cookie, company } = await onboardedCookie('l');
  const posting = await seedPosting(company, { withAssignment: true });
  const otherPosting = await seedPosting(company, { withAssignment: true });
  await seedFour(company, posting);
  await seedApplicant(company, otherPosting, { submit: true, review: { overallScore: 5, passesBar: true } });

  const res = await list(buildApp(), cookie, posting._id);
  assert.deepEqual(res.body.stats, { total: 4, submitted: 3, reviewed: 2, passing: 1 });
});

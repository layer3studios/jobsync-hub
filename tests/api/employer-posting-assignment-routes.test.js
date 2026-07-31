// FILE: tests/api/employer-posting-assignment-routes.test.js
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
  ensurePostingIndexes, ensureAssignmentIndexes,
  findOrCreateEmployerGoogleUser, createCompany, linkCompanyToEmployerUser,
  insertCompanyMember, insertAssignment, archiveAssignmentForCompany,
} from '../../src/models/employer/index.js';
import { ensureJobIndexes } from '../../src/models/shared/job-model.js';
import {
  ensureApplicationIndexes, createApplicationForCompany,
} from '../../src/models/public/application-model.js';
import {
  ensureAssignmentSubmissionIndexes, insertAssignmentSubmission,
} from '../../src/models/public/assignment-submission-model.js';

const VALID_POSTING = {
  title: 'React Developer', description: 'x'.repeat(60), location: 'Bangalore',
  workplaceType: 'remote', employmentType: 'full-time',
};

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

let roleSeq = 0;
async function addRoleCookie(companyId, role) {
  roleSeq += 1;
  const user = await findOrCreateEmployerGoogleUser({ googleId: `gr-${role}-${roleSeq}`, email: `r${role}${roleSeq}@acme.com`, name: role, picture: null });
  await linkCompanyToEmployerUser(user._id, companyId);
  await insertCompanyMember({ companyId, employerUserId: user._id, role, isFounder: false });
  return `jm_employer_token=${jwt.sign({ employerUserId: user._id.toString(), email: user.email }, EMPLOYER_JWT_SECRET)}`;
}

let assignmentSeq = 0;
async function seedAssignment(companyId, title = 'Rate limiter') {
  assignmentSeq += 1;
  return insertAssignment({
    companyId, title: `${title} ${assignmentSeq}`, publicSummary: 'A small backend exercise.',
    descriptionMarkdown: 'x'.repeat(60), estimatedHours: 4,
    submissionInstructionsMarkdown: 'Send a repo link.', allowedFileTypes: ['pdf'],
    createdByEmployerUserId: new ObjectId(),
  });
}

const createPosting = (app, cookie, body = VALID_POSTING) => request(app).post('/api/employer/jobs').set('Cookie', cookie).send(body);
const attach = (app, cookie, postingId, assignmentId) => request(app)
  .patch(`/api/employer/jobs/${postingId}/assignment`).set('Cookie', cookie).send({ assignmentId });
const getPanel = (app, cookie, postingId) => request(app)
  .get(`/api/employer/jobs/${postingId}/assignment`).set('Cookie', cookie);

before(async () => { await reset(); });
beforeEach(async () => { await reset(); });
after(async () => { await closeTestDb(); });
async function reset() {
  await dropCollections('jobs', 'assignments', 'applications', 'assignment_submissions',
    'contacts', 'companies', 'company_members', 'employer_users');
  await ensureCompanyIndexes(); await ensureEmployerUserIndexes(); await ensureCompanyMemberIndexes();
  await ensureJobIndexes(); await ensurePostingIndexes(); await ensureAssignmentIndexes();
  await ensureApplicationIndexes(); await ensureAssignmentSubmissionIndexes();
}

// ── Attach ───────────────────────────────────────────────────────────────────
test('PATCH attaches an assignment → 200, assignmentId set, previousAssignmentId null', async () => {
  const { cookie, company } = await onboardedCookie('a');
  const app = buildApp();
  const posting = (await createPosting(app, cookie)).body.posting;
  const assignment = await seedAssignment(company._id);

  const res = await attach(app, cookie, posting.id, assignment._id.toString());
  assert.equal(res.status, 200);
  assert.equal(res.body.posting.assignmentId, assignment._id.toString());
  assert.equal(res.body.previousAssignmentId, null);
  assert.equal(res.body.applicationCount, 0);
});

test('GET after attach returns the populated assignment and applicationCount 0', async () => {
  const { cookie, company } = await onboardedCookie('b');
  const app = buildApp();
  const posting = (await createPosting(app, cookie)).body.posting;
  const assignment = await seedAssignment(company._id);
  await attach(app, cookie, posting.id, assignment._id.toString());

  const res = await getPanel(app, cookie, posting.id);
  assert.equal(res.status, 200);
  assert.equal(res.body.assignment.id, assignment._id.toString());
  assert.equal(res.body.assignment.estimatedHours, 4);
  assert.equal(res.body.applicationCount, 0);
  assert.equal('companyId' in res.body.assignment, false);
});

test('GET on a posting with no assignment returns assignment null', async () => {
  const { cookie } = await onboardedCookie('c');
  const app = buildApp();
  const posting = (await createPosting(app, cookie)).body.posting;
  const res = await getPanel(app, cookie, posting.id);
  assert.equal(res.status, 200);
  assert.equal(res.body.assignment, null);
  assert.equal(res.body.applicationCount, 0);
});

test('attach works on a draft posting and on a closed posting', async () => {
  const { cookie, company } = await onboardedCookie('d');
  const app = buildApp();
  const assignment = await seedAssignment(company._id);

  const draft = (await createPosting(app, cookie, { ...VALID_POSTING, status: 'draft' })).body.posting;
  assert.equal((await attach(app, cookie, draft.id, assignment._id.toString())).status, 200);

  const live = (await createPosting(app, cookie, { ...VALID_POSTING, title: 'Closed Role' })).body.posting;
  await request(app).post(`/api/employer/jobs/${live.id}/close`).set('Cookie', cookie).send();
  const res = await attach(app, cookie, live.id, assignment._id.toString());
  assert.equal(res.status, 200);
  assert.equal(res.body.posting.status, 'closed');
  assert.equal(res.body.posting.assignmentId, assignment._id.toString());
});

// ── Swap ─────────────────────────────────────────────────────────────────────
test('SWAP: attaching B over A reports A as previousAssignmentId', async () => {
  const { cookie, company } = await onboardedCookie('e');
  const app = buildApp();
  const posting = (await createPosting(app, cookie)).body.posting;
  const a = await seedAssignment(company._id, 'Task A');
  const b = await seedAssignment(company._id, 'Task B');

  await attach(app, cookie, posting.id, a._id.toString());
  const res = await attach(app, cookie, posting.id, b._id.toString());
  assert.equal(res.status, 200);
  assert.equal(res.body.previousAssignmentId, a._id.toString());
  assert.equal(res.body.posting.assignmentId, b._id.toString());
});

// ── Detach ───────────────────────────────────────────────────────────────────
test('DETACH: { assignmentId: null } clears it and is idempotent', async () => {
  const { cookie, company } = await onboardedCookie('f');
  const app = buildApp();
  const posting = (await createPosting(app, cookie)).body.posting;
  const assignment = await seedAssignment(company._id);
  await attach(app, cookie, posting.id, assignment._id.toString());

  const first = await attach(app, cookie, posting.id, null);
  assert.equal(first.status, 200);
  assert.equal(first.body.posting.assignmentId, null);
  assert.equal(first.body.previousAssignmentId, assignment._id.toString());

  const second = await attach(app, cookie, posting.id, null);
  assert.equal(second.status, 200);
  assert.equal(second.body.posting.assignmentId, null);
  assert.equal(second.body.previousAssignmentId, null);
});

test('DETACH leaves an existing submission untouched — past candidates stay reviewable', async () => {
  const { cookie, company } = await onboardedCookie('g');
  const app = buildApp();
  const posting = (await createPosting(app, cookie)).body.posting;
  const assignment = await seedAssignment(company._id);
  await attach(app, cookie, posting.id, assignment._id.toString());

  const application = await createApplicationForCompany(company._id, {
    jobId: posting.id, contactId: new ObjectId(), stageId: new ObjectId(),
  });
  const submission = await insertAssignmentSubmission({
    applicationId: application._id, companyId: company._id, jobId: posting.id,
    links: [{ url: 'https://example.com/repo', addedAt: new Date() }],
    seekerNotesMarkdown: 'Done.',
  });

  await attach(app, cookie, posting.id, null);

  const submissions = await col('assignment_submissions');
  const stored = await submissions.findOne({ _id: submission._id });
  assert.ok(stored, 'submission row must survive a detach');
  assert.equal(stored.applicationId.toString(), application._id.toString());
  assert.equal(stored.links.length, 1);
  assert.equal(stored.seekerNotesMarkdown, 'Done.');
  assert.equal(stored.filesDeletedAt, null);
});

// ── Rejections ───────────────────────────────────────────────────────────────
test('an ARCHIVED assignment → 400 ASSIGNMENT_ARCHIVED and the posting is unchanged', async () => {
  const { cookie, company } = await onboardedCookie('h');
  const app = buildApp();
  const posting = (await createPosting(app, cookie)).body.posting;
  const assignment = await seedAssignment(company._id);
  await archiveAssignmentForCompany(company._id, assignment._id);

  const res = await attach(app, cookie, posting.id, assignment._id.toString());
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'ASSIGNMENT_ARCHIVED');

  const panel = await getPanel(app, cookie, posting.id);
  assert.equal(panel.body.assignment, null);
});

test('a posting keeps working when its attached assignment is archived AFTERWARDS', async () => {
  const { cookie, company } = await onboardedCookie('h2');
  const app = buildApp();
  const posting = (await createPosting(app, cookie)).body.posting;
  const assignment = await seedAssignment(company._id);
  await attach(app, cookie, posting.id, assignment._id.toString());
  await archiveAssignmentForCompany(company._id, assignment._id);

  const panel = await getPanel(app, cookie, posting.id);
  assert.equal(panel.status, 200);
  assert.equal(panel.body.assignment.id, assignment._id.toString());
  assert.ok(panel.body.assignment.archivedAt);
});

test('a cross-tenant assignment → 404 ASSIGNMENT_NOT_FOUND', async () => {
  const { cookie } = await onboardedCookie('i');
  const other = await onboardedCookie('i2');
  const app = buildApp();
  const posting = (await createPosting(app, cookie)).body.posting;
  const theirs = await seedAssignment(other.company._id);

  const res = await attach(app, cookie, posting.id, theirs._id.toString());
  assert.equal(res.status, 404);
  assert.equal(res.body.code, 'ASSIGNMENT_NOT_FOUND');
});

test('a cross-tenant posting → 404 from requireEmployerPosting', async () => {
  const { cookie, company } = await onboardedCookie('j');
  const other = await onboardedCookie('j2');
  const app = buildApp();
  const posting = (await createPosting(app, cookie)).body.posting;
  const assignment = await seedAssignment(other.company._id);

  const res = await attach(app, other.cookie, posting.id, assignment._id.toString());
  assert.equal(res.status, 404);
  assert.equal(res.body.code, 'POSTING_NOT_FOUND');
  assert.equal((await getPanel(app, other.cookie, posting.id)).status, 404);
  // The posting really is untouched.
  const jobs = await col('jobs');
  const stored = await jobs.findOne({ _id: new ObjectId(posting.id) });
  assert.equal(stored.assignmentId, null);
  assert.equal(stored.companyId.toString(), company._id.toString());
});

test('a SCRAPED job id → 404, and the scraped doc gains no assignmentId', async () => {
  const { cookie, company } = await onboardedCookie('k');
  const app = buildApp();
  const assignment = await seedAssignment(company._id);
  // A scraped ATS row: PascalCase, no `source`, no companyId.
  const jobs = await col('jobs');
  const { insertedId } = await jobs.insertOne({
    JobID: 'ats-9001', JobTitle: 'Scraped Backend Role', Company: 'SomeCorp', Location: 'Pune',
  });

  const res = await attach(app, cookie, insertedId.toString(), assignment._id.toString());
  assert.equal(res.status, 404);
  assert.equal(res.body.code, 'POSTING_NOT_FOUND');
  assert.equal((await getPanel(app, cookie, insertedId.toString())).status, 404);

  const stored = await jobs.findOne({ _id: insertedId });
  assert.equal('assignmentId' in stored, false, 'scraped job must not be mutated');
  assert.equal('updatedAt' in stored, false);
  assert.equal(stored.JobTitle, 'Scraped Backend Role');
});

test('body validation: missing key, wrong type, and unknown key each get their own code', async () => {
  const { cookie } = await onboardedCookie('l');
  const app = buildApp();
  const posting = (await createPosting(app, cookie)).body.posting;
  const url = `/api/employer/jobs/${posting.id}/assignment`;

  const missing = await request(app).patch(url).set('Cookie', cookie).send({});
  assert.equal(missing.status, 400);
  assert.equal(missing.body.code, 'MISSING_ASSIGNMENT_ID');

  const wrongType = await request(app).patch(url).set('Cookie', cookie).send({ assignmentId: 123 });
  assert.equal(wrongType.status, 400);
  assert.equal(wrongType.body.code, 'INVALID_ASSIGNMENT_ID');

  const unknown = await request(app).patch(url).set('Cookie', cookie).send({ assignmentId: null, foo: 1 });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.code, 'UNKNOWN_FIELD');
  assert.match(unknown.body.error, /foo/);
});

// ── Application count ────────────────────────────────────────────────────────
test('applicationCount reflects the posting\'s applications on both GET and PATCH', async () => {
  const { cookie, company } = await onboardedCookie('m');
  const app = buildApp();
  const posting = (await createPosting(app, cookie)).body.posting;
  const assignment = await seedAssignment(company._id);
  for (let i = 0; i < 3; i += 1) {
    await createApplicationForCompany(company._id, {
      jobId: posting.id, contactId: new ObjectId(), stageId: new ObjectId(),
    });
  }

  const panel = await getPanel(app, cookie, posting.id);
  assert.equal(panel.body.applicationCount, 3);

  const patched = await attach(app, cookie, posting.id, assignment._id.toString());
  assert.equal(patched.body.applicationCount, 3);
});

// ── Role gates ───────────────────────────────────────────────────────────────
test('gating — interviewer can GET but not PATCH; member can PATCH', async () => {
  const { cookie, company } = await onboardedCookie('n');
  const app = buildApp();
  const posting = (await createPosting(app, cookie)).body.posting;
  const assignment = await seedAssignment(company._id);
  const interviewer = await addRoleCookie(company._id, 'interviewer');
  const member = await addRoleCookie(company._id, 'member');

  assert.equal((await getPanel(app, interviewer, posting.id)).status, 200);
  assert.equal((await attach(app, interviewer, posting.id, assignment._id.toString())).status, 403);
  assert.equal((await attach(app, member, posting.id, assignment._id.toString())).status, 200);
});

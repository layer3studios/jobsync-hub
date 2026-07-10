// FILE: tests/api/employer-applicant-routes.test.js
// End-to-end auth + happy paths for /api/employer/applicants. Seeds a company via
// the real onboarding helpers (for a valid cookie), then inserts an application +
// stage + reason directly to exercise detail/move/archive/unarchive/resume-url.
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
import employerApplicantRouter from '../../src/api/employer/employer-applicant-routes.js';
import {
  ensureCompanyIndexes, ensureEmployerUserIndexes,
  findOrCreateEmployerGoogleUser, createCompany, linkCompanyToEmployerUser,
} from '../../src/models/employer/index.js';
import {
  ensureResumeScoreJobIndexes, insertScoreJob, claimNextScoreJob, markScoreJobDone,
} from '../../src/models/public/resume-score-job-model.js';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/employer/applicants', requireEmployer, requireEmployerCompany, employerApplicantRouter);
  app.use(errorHandler);
  return app;
}

async function onboardedCookie(tag) {
  const user = await findOrCreateEmployerGoogleUser({ googleId: `g-${tag}`, email: `o${tag}@acme.com`, name: 'Owner', picture: null });
  const company = await createCompany({ name: `Acme ${tag}` }, user._id);
  await linkCompanyToEmployerUser(user._id, company._id);
  const token = jwt.sign({ employerUserId: user._id.toString(), email: user.email }, EMPLOYER_JWT_SECRET);
  return { cookie: `jm_employer_token=${token}`, company };
}

// A signed-in employer with NO company linked — trips requireEmployerCompany (403).
async function noCompanyCookie(tag) {
  const user = await findOrCreateEmployerGoogleUser({ googleId: `gnc-${tag}`, email: `nc${tag}@acme.com`, name: 'NoCo', picture: null });
  const token = jwt.sign({ employerUserId: user._id.toString(), email: user.email }, EMPLOYER_JWT_SECRET);
  return `jm_employer_token=${token}`;
}

async function insertReason(companyId) {
  return (await (await col('archive_reasons')).insertOne({ companyId, text: 'Underqualified', type: 'non-hired' })).insertedId;
}

function postBulk(app, cookie, body) {
  const req = request(app).post('/api/employer/applicants/bulk/archive');
  if (cookie) req.set('Cookie', cookie);
  return req.send(body);
}

async function seedApplicant(companyId, { stageId, archived = null }) {
  const contact = await (await col('contacts')).insertOne({ companyId, email: 'asha@x.com', fullName: 'Asha' });
  const application = await (await col('applications')).insertOne({
    companyId, contactId: contact.insertedId, jobId: new ObjectId(), stageId, archived, appliedAt: new Date(),
  });
  return application.insertedId;
}

before(async () => { await reset(); });
beforeEach(async () => { await reset(); });
after(async () => { await closeTestDb(); });
async function reset() {
  await dropCollections('companies', 'employer_users', 'applications', 'contacts', 'stages', 'archive_reasons', 'stage_changes', 'resume_scores', 'resume_files', 'resume_score_jobs');
  await ensureCompanyIndexes(); await ensureEmployerUserIndexes();
  await ensureResumeScoreJobIndexes();
}

const rescorePath = (appId) => `/api/employer/applicants/${appId}/rescore`;

test('GET detail requires auth (401 without cookie)', async () => {
  const res = await request(buildApp()).get(`/api/employer/applicants/${new ObjectId()}`);
  assert.equal(res.status, 401);
});

test('GET detail returns the applicant sections', async () => {
  const { cookie, company } = await onboardedCookie('a');
  const stageId = new ObjectId();
  const appId = await seedApplicant(company._id, { stageId });
  const res = await request(buildApp()).get(`/api/employer/applicants/${appId}`).set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.equal(res.body.applicant.contact.email, 'asha@x.com');
  assert.equal(res.body.applicant.resumeMeta, null);
});

test('POST move → 200 and updates stage', async () => {
  const { cookie, company } = await onboardedCookie('b');
  const fromStage = new ObjectId();
  const toStage = (await (await col('stages')).insertOne({ companyId: company._id, text: 'Shortlisted', order: 2 })).insertedId;
  const appId = await seedApplicant(company._id, { stageId: fromStage });
  const res = await request(buildApp()).post(`/api/employer/applicants/${appId}/move`).set('Cookie', cookie).send({ stageId: toStage.toString(), note: 'good' });
  assert.equal(res.status, 200);
  assert.equal(res.body.application.stageId, toStage.toString());
});

test('POST archive then unarchive → 200 each', async () => {
  const { cookie, company } = await onboardedCookie('c');
  const reasonId = (await (await col('archive_reasons')).insertOne({ companyId: company._id, text: 'Underqualified', type: 'non-hired' })).insertedId;
  const appId = await seedApplicant(company._id, { stageId: new ObjectId() });
  const archived = await request(buildApp()).post(`/api/employer/applicants/${appId}/archive`).set('Cookie', cookie).send({ reasonId: reasonId.toString() });
  assert.equal(archived.status, 200);
  assert.equal(archived.body.application.archived.reasonId, reasonId.toString());
  const unarchived = await request(buildApp()).post(`/api/employer/applicants/${appId}/unarchive`).set('Cookie', cookie);
  assert.equal(unarchived.status, 200);
  assert.equal(unarchived.body.application.archived, null);
});

test('GET resume-url returns a signed URL with a 15-min expiry', async () => {
  const { cookie, company } = await onboardedCookie('d');
  const appId = await seedApplicant(company._id, { stageId: new ObjectId() });
  const res = await request(buildApp()).get(`/api/employer/applicants/${appId}/resume-url`).set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.body.url, /\/api\/public\/resume-download\?token=/);
  const millisecondsAway = new Date(res.body.expiresAt).getTime() - Date.now();
  assert.ok(millisecondsAway > 14 * 60 * 1000 && millisecondsAway <= 15 * 60 * 1000);
});

test('POST bulk/archive unauthenticated → 401', async () => {
  const res = await postBulk(buildApp(), null, { applicationIds: [new ObjectId().toString()], reasonId: new ObjectId().toString() });
  assert.equal(res.status, 401);
});

test('POST bulk/archive without a company → 403', async () => {
  const cookie = await noCompanyCookie('e');
  const res = await postBulk(buildApp(), cookie, { applicationIds: [new ObjectId().toString()], reasonId: new ObjectId().toString() });
  assert.equal(res.status, 403);
});

test('POST bulk/archive happy path → 200 with per-item body shape', async () => {
  const { cookie, company } = await onboardedCookie('f');
  const reasonId = await insertReason(company._id);
  const a1 = await seedApplicant(company._id, { stageId: new ObjectId() });
  const a2 = await seedApplicant(company._id, { stageId: new ObjectId() });
  const res = await postBulk(buildApp(), cookie, { applicationIds: [a1.toString(), a2.toString()], reasonId: reasonId.toString() });
  assert.equal(res.status, 200);
  assert.equal(res.body.total, 2);
  assert.equal(res.body.successCount, 2);
  assert.equal(res.body.failureCount, 0);
  assert.ok(Array.isArray(res.body.succeeded) && Array.isArray(res.body.failed));
});

test('POST bulk/archive empty array → 400 BULK_EMPTY', async () => {
  const { cookie, company } = await onboardedCookie('g');
  const reasonId = await insertReason(company._id);
  const res = await postBulk(buildApp(), cookie, { applicationIds: [], reasonId: reasonId.toString() });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'BULK_EMPTY');
});

test('POST bulk/archive >50 items → 400 BULK_LIMIT_EXCEEDED', async () => {
  const { cookie, company } = await onboardedCookie('h');
  const reasonId = await insertReason(company._id);
  const ids = Array.from({ length: 51 }, () => new ObjectId().toString());
  const res = await postBulk(buildApp(), cookie, { applicationIds: ids, reasonId: reasonId.toString() });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'BULK_LIMIT_EXCEEDED');
});

test('POST bulk/archive mixed → 200 with per-item breakdown', async () => {
  const { cookie, company } = await onboardedCookie('i');
  const reasonId = await insertReason(company._id);
  const ok = await seedApplicant(company._id, { stageId: new ObjectId() });
  const missing = new ObjectId().toString();
  const res = await postBulk(buildApp(), cookie, { applicationIds: [ok.toString(), missing], reasonId: reasonId.toString() });
  assert.equal(res.status, 200);
  assert.equal(res.body.successCount, 1);
  assert.equal(res.body.failureCount, 1);
  assert.equal(res.body.succeeded[0].id, ok.toString());
  assert.equal(res.body.failed[0].id, missing);
  assert.equal(res.body.failed[0].code, 'APPLICATION_NOT_FOUND');
});

test('route order: /bulk/archive is not shadowed by /:applicationId, detail still resolves', async () => {
  const { cookie, company } = await onboardedCookie('j');
  const appId = await seedApplicant(company._id, { stageId: new ObjectId() });
  // The parameterized GET route still resolves a real applicationId.
  const detail = await request(buildApp()).get(`/api/employer/applicants/${appId}`).set('Cookie', cookie);
  assert.equal(detail.status, 200);
  // 'bulk' is NOT captured as an applicationId — the bulk handler runs.
  const reasonId = await insertReason(company._id);
  const bulk = await postBulk(buildApp(), cookie, { applicationIds: [appId.toString()], reasonId: reasonId.toString() });
  assert.equal(bulk.status, 200);
  assert.equal(bulk.body.total, 1);
});

// ---------------------------------------------------------------------------
// POST /:applicationId/rescore (T1.2 D13)
// ---------------------------------------------------------------------------

// D13(l)
test('POST rescore requires auth (401 without cookie)', async () => {
  const res = await request(buildApp()).post(rescorePath(new ObjectId()));
  assert.equal(res.status, 401);
});

// D13(i)
test('POST rescore on a done job → 202 with a freshly queued job', async () => {
  const { cookie, company } = await onboardedCookie('rs1');
  const appId = await seedApplicant(company._id, { stageId: new ObjectId() });
  await insertScoreJob(appId, company._id, new ObjectId());
  const claimed = await claimNextScoreJob(0);
  await markScoreJobDone(claimed._id);

  const res = await request(buildApp()).post(rescorePath(appId)).set('Cookie', cookie);
  assert.equal(res.status, 202);
  assert.equal(res.body.rescored, true);
  assert.equal(res.body.jobStatus, 'queued');
  assert.equal(res.body.attemptCount, 0);
  assert.equal(typeof res.body.jobId, 'string');
  assert.equal(res.body.jobId, claimed._id.toString(), 'reset the same job, no duplicate');
});

test('POST rescore with no existing job → 202 and inserts one', async () => {
  const { cookie, company } = await onboardedCookie('rs2');
  const appId = await seedApplicant(company._id, { stageId: new ObjectId() });
  const res = await request(buildApp()).post(rescorePath(appId)).set('Cookie', cookie);
  assert.equal(res.status, 202);
  assert.deepEqual(
    { rescored: res.body.rescored, jobStatus: res.body.jobStatus, attemptCount: res.body.attemptCount },
    { rescored: true, jobStatus: 'queued', attemptCount: 0 },
  );
});

// D13(j) — idempotency: already in flight is a no-op.
test('POST rescore while the job is queued → 200 no-op with the current status', async () => {
  const { cookie, company } = await onboardedCookie('rs3');
  const appId = await seedApplicant(company._id, { stageId: new ObjectId() });
  const inserted = await insertScoreJob(appId, company._id, new ObjectId());

  const res = await request(buildApp()).post(rescorePath(appId)).set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.equal(res.body.rescored, false);
  assert.equal(res.body.jobStatus, 'queued');
  assert.equal(res.body.jobId, inserted.jobId);
});

test('POST rescore while the job is processing → 200 no-op, lock is not stolen', async () => {
  const { cookie, company } = await onboardedCookie('rs4');
  const appId = await seedApplicant(company._id, { stageId: new ObjectId() });
  await insertScoreJob(appId, company._id, new ObjectId());
  const claimed = await claimNextScoreJob(0);

  const res = await request(buildApp()).post(rescorePath(appId)).set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.equal(res.body.rescored, false);
  assert.equal(res.body.jobStatus, 'processing');
  assert.equal(res.body.attemptCount, claimed.attemptCount);
});

// D13(k)
test('POST rescore on another company\'s application → 404, no job created', async () => {
  const owner = await onboardedCookie('rs5');
  const intruder = await onboardedCookie('rs6');
  const appId = await seedApplicant(owner.company._id, { stageId: new ObjectId() });

  const res = await request(buildApp()).post(rescorePath(appId)).set('Cookie', intruder.cookie);
  assert.equal(res.status, 404);
  assert.equal(res.body.code, 'APPLICATION_NOT_FOUND');
  const count = await (await col('resume_score_jobs')).countDocuments({});
  assert.equal(count, 0, 'a cross-tenant rescore must not queue anything');
});

test('POST rescore with a malformed applicationId → 400', async () => {
  const { cookie } = await onboardedCookie('rs7');
  const res = await request(buildApp()).post(rescorePath('not-an-oid')).set('Cookie', cookie);
  assert.equal(res.status, 400);
});

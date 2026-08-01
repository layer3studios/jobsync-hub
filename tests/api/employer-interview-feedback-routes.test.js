// FILE: tests/api/employer-interview-feedback-routes.test.js
import './../_helpers/test-db.js';
import { test, beforeEach, after } from 'node:test';
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
import employerInterviewRouter from '../../src/api/employer/employer-interview-routes.js';
import employerApplicantRouter from '../../src/api/employer/employer-applicant-routes.js';
import {
  findOrCreateEmployerGoogleUser, createCompany, linkCompanyToEmployerUser, insertCompanyMember,
} from '../../src/models/employer/index.js';
import { seedDefaultStagesForCompany } from '../../src/models/employer/stage-model.js';

const HOUR_MS = 3600000;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/employer/applicants', requireEmployer, requireEmployerCompany, employerApplicantRouter);
  app.use('/api/employer', requireEmployer, requireEmployerCompany, employerInterviewRouter);
  app.use(errorHandler);
  return app;
}

async function onboarded(tag) {
  const user = await findOrCreateEmployerGoogleUser({ googleId: `g-${tag}`, email: `o${tag}@acme.com`, name: 'Owner', picture: null });
  const company = await createCompany({ name: `Acme ${tag}` }, user._id);
  await linkCompanyToEmployerUser(user._id, company._id);
  await insertCompanyMember({ companyId: company._id, employerUserId: user._id, role: 'founder', isFounder: true });
  const stages = await seedDefaultStagesForCompany(company._id);
  const token = jwt.sign({ employerUserId: user._id.toString(), email: user.email }, EMPLOYER_JWT_SECRET);
  return { cookie: `jm_employer_token=${token}`, companyId: company._id, stages };
}

async function seedInterviewWithApplication(companyId, stages, { startOffsetHours = -2 } = {}) {
  const now = new Date();
  const { insertedId: contactId } = await (await col('contacts')).insertOne({ companyId, fullName: 'Ada', email: 'ada@x.io' });
  const { insertedId: appId } = await (await col('applications')).insertOne({
    companyId, jobId: new ObjectId(), contactId, stageId: stages[0]._id, archived: null,
    appliedAt: now, lastStageMovedAt: now, createdAt: now, updatedAt: now,
  });
  const { insertedId: interviewId } = await (await col('interviews')).insertOne({
    companyId, applicationId: appId, postingId: new ObjectId(), contactId,
    status: 'scheduled', startAtUtc: new Date(Date.now() + startOffsetHours * HOUR_MS),
    durationMinutes: 45, createdAt: now, updatedAt: now,
  });
  return { appId, interviewId };
}

const FEEDBACK = { recommendation: 'yes', feedbackText: 'Sharp answers on system design questions.' };

beforeEach(async () => {
  await dropCollections(
    'companies', 'company_members', 'employer_users', 'stages', 'jobs',
    'applications', 'contacts', 'interviews', 'stage_changes', 'applicant_notes',
    'resume_scores', 'resume_score_jobs', 'audit_log',
  );
});
after(async () => { await closeTestDb(); });

test('POST /complete → 200 with nextAction and the updated interview', async () => {
  const { cookie, companyId, stages } = await onboarded('a');
  const { interviewId } = await seedInterviewWithApplication(companyId, stages);
  const res = await request(buildApp())
    .post(`/api/employer/interviews/${interviewId}/complete`).set('Cookie', cookie).send(FEEDBACK);
  assert.equal(res.status, 200);
  assert.equal(res.body.data.interview.status, 'completed');
  assert.equal(res.body.data.nextAction, 'advance');
  assert.ok(res.body.data.suggestedStage);
});

test('POST /no-show → 200 with the flag action', async () => {
  const { cookie, companyId, stages } = await onboarded('b');
  const { interviewId } = await seedInterviewWithApplication(companyId, stages);
  const res = await request(buildApp())
    .post(`/api/employer/interviews/${interviewId}/no-show`).set('Cookie', cookie).send({ note: 'silence' });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.interview.status, 'no_show');
  assert.equal(res.body.data.nextAction, 'flag');
});

test('POST /complete on a future interview → 400 INTERVIEW_NOT_YET', async () => {
  const { cookie, companyId, stages } = await onboarded('c');
  const { interviewId } = await seedInterviewWithApplication(companyId, stages, { startOffsetHours: 5 });
  const res = await request(buildApp())
    .post(`/api/employer/interviews/${interviewId}/complete`).set('Cookie', cookie).send(FEEDBACK);
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'INTERVIEW_NOT_YET');
});

test('GET /applicants/:id/timeline → 200 with an events array', async () => {
  const { cookie, companyId, stages } = await onboarded('d');
  const { appId, interviewId } = await seedInterviewWithApplication(companyId, stages);
  await request(buildApp())
    .post(`/api/employer/interviews/${interviewId}/complete`).set('Cookie', cookie).send(FEEDBACK);

  const res = await request(buildApp())
    .get(`/api/employer/applicants/${appId}/timeline`).set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.data));
  const types = res.body.data.map((event) => event.type);
  assert.ok(types.includes('applied'));
  assert.ok(types.includes('interview_completed'));
  assert.ok(!JSON.stringify(res.body.data).includes('companyId'));
});

// FILE: tests/api/employer-dashboard-routes.test.js
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
import employerDashboardRouter from '../../src/api/employer/employer-dashboard-routes.js';
import {
  findOrCreateEmployerGoogleUser, createCompany, linkCompanyToEmployerUser, insertCompanyMember,
} from '../../src/models/employer/index.js';
import { seedDefaultStagesForCompany } from '../../src/models/employer/stage-model.js';

const DAY_MS = 86400000;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/employer/dashboard', requireEmployer, requireEmployerCompany, employerDashboardRouter);
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

/** Seed a posting + contact + application (+ optional score) for a company. */
async function seedHiringData(companyId, stages, { name = 'Ada', email = 'ada@x.io', score = null } = {}) {
  const now = new Date();
  const { insertedId: jobId } = await (await col('jobs')).insertOne({
    companyId, source: 'native', status: 'active', title: 'React Dev', slug: `react-${email}`,
    location: 'Remote', workplaceType: 'remote', createdAt: now, updatedAt: now,
  });
  const { insertedId: contactId } = await (await col('contacts')).insertOne({ companyId, fullName: name, email });
  const { insertedId: appId } = await (await col('applications')).insertOne({
    companyId, jobId, contactId, stageId: stages[0]._id, archived: null,
    appliedAt: now, lastStageMovedAt: now, createdAt: now, updatedAt: now,
  });
  if (score !== null) await (await col('resume_scores')).insertOne({ applicationId: appId, companyId, score });
  return { jobId, contactId, appId };
}

beforeEach(async () => {
  await dropCollections(
    'jobs', 'companies', 'company_members', 'employer_users', 'stages',
    'applications', 'contacts', 'resume_scores', 'resume_score_jobs', 'interviews', 'stage_changes',
  );
});
after(async () => { await closeTestDb(); });

test('GET /summary → 200 with all five KPIs and correct types', async () => {
  const { cookie, companyId, stages } = await onboarded('a');
  await seedHiringData(companyId, stages, { score: 80 });
  const res = await request(buildApp()).get('/api/employer/dashboard/summary').set('Cookie', cookie);
  assert.equal(res.status, 200);
  const { kpis, activeJobs, topCandidates } = res.body.data;
  assert.equal(kpis.activeJobs, 1);
  assert.equal(kpis.totalApplicants, 1);
  assert.equal(typeof kpis.interviewsThisWeek, 'number');
  assert.equal(kpis.avgAiScore, 80);
  assert.equal(kpis.avgDaysToHire, null);
  assert.equal(activeJobs.length, 1);
  assert.equal(topCandidates.length, 1);
  assert.ok(!('companyId' in topCandidates[0]));
  assert.ok(!('contactId' in topCandidates[0]));
  assert.ok(!('resumeUrl' in topCandidates[0]));
});

test('GET /activity → events sorted by timestamp desc, no internal ids', async () => {
  const { cookie, companyId, stages } = await onboarded('b');
  const { jobId, contactId, appId } = await seedHiringData(companyId, stages);
  const now = Date.now();
  await (await col('stage_changes')).insertOne({
    applicationId: appId, fromStageId: stages[0]._id, toStageId: stages[1]._id,
    movedByUserId: null, movedAt: new Date(now + 1000), note: null,
  });
  await (await col('applications')).updateOne({ _id: appId }, { $set: { lastStageMovedAt: new Date(now + 1000) } });
  await (await col('interviews')).insertOne({
    companyId, applicationId: appId, postingId: jobId, contactId,
    status: 'scheduled', startAtUtc: new Date(now + 3 * DAY_MS),
    bookedAt: new Date(now + 2000), createdAt: new Date(now + 2000),
  });

  const res = await request(buildApp()).get('/api/employer/dashboard/activity').set('Cookie', cookie);
  assert.equal(res.status, 200);
  const events = res.body.data;
  assert.ok(events.length >= 3);
  const times = events.map((event) => new Date(event.timestamp).getTime());
  assert.deepEqual(times, [...times].sort((a, b) => b - a));
  assert.deepEqual(events.map((event) => event.type), ['interview_booked', 'stage_move', 'application']);
  assert.equal(events[1].fromStage, 'Applied');
  assert.equal(events[1].toStage, 'Shortlisted');
  for (const event of events) {
    assert.ok(!('companyId' in event));
    assert.ok(!('contactId' in event));
    assert.ok(!('applicationId' in event));
    assert.equal(event.candidateName, 'Ada');
    assert.equal(event.postingTitle, 'React Dev');
  }
});

test('cross-tenant: company B\'s data never appears in either endpoint', async () => {
  const a = await onboarded('c');
  const b = await onboarded('d');
  await seedHiringData(b.companyId, b.stages, { name: 'Mallory', email: 'mal@evil.io', score: 99 });

  const app = buildApp();
  const summary = await request(app).get('/api/employer/dashboard/summary').set('Cookie', a.cookie);
  assert.equal(summary.status, 200);
  assert.equal(summary.body.data.kpis.totalApplicants, 0);
  assert.deepEqual(summary.body.data.activeJobs, []);
  assert.deepEqual(summary.body.data.topCandidates, []);

  const activity = await request(app).get('/api/employer/dashboard/activity').set('Cookie', a.cookie);
  assert.equal(activity.status, 200);
  assert.deepEqual(activity.body.data, []);
  assert.ok(!JSON.stringify(summary.body).includes('Mallory'));
  assert.ok(!JSON.stringify(activity.body).includes('Mallory'));
});

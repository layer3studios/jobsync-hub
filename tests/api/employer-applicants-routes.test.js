// FILE: tests/api/employer-applicants-routes.test.js
// GET /api/employer/jobs/:postingId/applicants — merges application + contact +
// score, tenant-scoped. Seeds two applications with scores directly, then asserts
// merge, sorting, archived filter, cross-tenant isolation, and auth.
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
  ensureCompanyIndexes, ensureEmployerUserIndexes, ensurePostingIndexes,
  findOrCreateEmployerGoogleUser, createCompany, linkCompanyToEmployerUser,
  insertCompanyMember, ensureCompanyMemberIndexes,
  createPostingForCompany,
} from '../../src/models/employer/index.js';
import { ensureResumeScoreIndexes, upsertResumeScore } from '../../src/models/public/resume-score-model.js';

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

async function seedApplicant(companyId, jobId, { email, score, appliedAt, archived = null }) {
  const contact = await (await col('contacts')).insertOne({ companyId, email, fullName: email });
  const application = await (await col('applications')).insertOne({
    companyId, jobId, contactId: contact.insertedId, archived, appliedAt, source: 'apply_page',
  });
  if (score != null) await upsertResumeScore(application.insertedId, companyId, { score });
  return application.insertedId;
}

before(async () => { await reset(); });
beforeEach(async () => { await reset(); });
after(async () => { await closeTestDb(); });
async function reset() {
  await dropCollections('jobs', 'companies', 'company_members', 'employer_users', 'applications', 'contacts', 'resume_scores');
  await ensureCompanyIndexes(); await ensureEmployerUserIndexes(); await ensureCompanyMemberIndexes(); await ensurePostingIndexes();
  await ensureResumeScoreIndexes();
}

const POSTING_INPUT = {
  title: 'React Developer', description: 'x'.repeat(60), location: 'Bangalore',
  workplaceType: 'remote', employmentType: 'full-time',
};

test('returns applications joined with contact + score', async () => {
  const { cookie, company } = await onboardedCookie('a');
  const posting = await createPostingForCompany(company._id, POSTING_INPUT);
  await seedApplicant(company._id, posting._id, { email: 'asha@x.com', score: 70, appliedAt: new Date('2026-06-01') });
  const res = await request(buildApp()).get(`/api/employer/jobs/${posting._id}/applicants`).set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.equal(res.body.applicants.length, 1);
  const row = res.body.applicants[0];
  assert.equal(row.contact.email, 'asha@x.com');
  assert.equal(row.score.score, 70);
});

test('?sort=score sorts by score desc (default)', async () => {
  const { cookie, company } = await onboardedCookie('b');
  const posting = await createPostingForCompany(company._id, POSTING_INPUT);
  await seedApplicant(company._id, posting._id, { email: 'low@x.com', score: 30, appliedAt: new Date('2026-06-02') });
  await seedApplicant(company._id, posting._id, { email: 'high@x.com', score: 90, appliedAt: new Date('2026-06-01') });
  const res = await request(buildApp()).get(`/api/employer/jobs/${posting._id}/applicants?sort=score`).set('Cookie', cookie);
  assert.equal(res.body.applicants[0].contact.email, 'high@x.com');
});

test('?sort=date sorts by appliedAt desc', async () => {
  const { cookie, company } = await onboardedCookie('c');
  const posting = await createPostingForCompany(company._id, POSTING_INPUT);
  await seedApplicant(company._id, posting._id, { email: 'older@x.com', score: 90, appliedAt: new Date('2026-06-01') });
  await seedApplicant(company._id, posting._id, { email: 'newer@x.com', score: 30, appliedAt: new Date('2026-06-05') });
  const res = await request(buildApp()).get(`/api/employer/jobs/${posting._id}/applicants?sort=date`).set('Cookie', cookie);
  assert.equal(res.body.applicants[0].contact.email, 'newer@x.com');
});

test('?archived=false excludes archived applications', async () => {
  const { cookie, company } = await onboardedCookie('d');
  const posting = await createPostingForCompany(company._id, POSTING_INPUT);
  await seedApplicant(company._id, posting._id, { email: 'active@x.com', score: 50, appliedAt: new Date('2026-06-01') });
  await seedApplicant(company._id, posting._id, { email: 'gone@x.com', score: 50, appliedAt: new Date('2026-06-02'), archived: { at: new Date() } });
  const res = await request(buildApp()).get(`/api/employer/jobs/${posting._id}/applicants?archived=false`).set('Cookie', cookie);
  assert.equal(res.body.applicants.length, 1);
  assert.equal(res.body.applicants[0].contact.email, 'active@x.com');
});

test('cross-tenant posting id → 404 (never leaks another company)', async () => {
  const { company: companyA } = await onboardedCookie('e');
  const posting = await createPostingForCompany(companyA._id, POSTING_INPUT);
  const { cookie: cookieB } = await onboardedCookie('f');
  const res = await request(buildApp()).get(`/api/employer/jobs/${posting._id}/applicants`).set('Cookie', cookieB);
  assert.equal(res.status, 404);
});

test('401 without auth', async () => {
  const res = await request(buildApp()).get(`/api/employer/jobs/${new ObjectId()}/applicants`);
  assert.equal(res.status, 401);
});

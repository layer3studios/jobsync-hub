// FILE: tests/api/employer-postings-routes.test.js
import './../_helpers/test-db.js';
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import jwt from 'jsonwebtoken';

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
} from '../../src/models/employer/index.js';
import { ensureJobIndexes } from '../../src/models/shared/job-model.js';

const VALID_BODY = {
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

before(async () => { await reset(); });
beforeEach(async () => { await reset(); });
after(async () => { await closeTestDb(); });
async function reset() {
  await dropCollections('jobs', 'companies', 'company_members', 'employer_users');
  // ensureJobIndexes() mirrors real server boot: `jobs` is shared with scraped
  // jobs, so its indexes must be present for these routes to be exercised honestly.
  await ensureCompanyIndexes(); await ensureEmployerUserIndexes(); await ensureCompanyMemberIndexes();
  await ensureJobIndexes(); await ensurePostingIndexes();
}

test('POST creates a posting → 201 with the full public shape', async () => {
  const { cookie } = await onboardedCookie('a');
  const res = await request(buildApp()).post('/api/employer/jobs').set('Cookie', cookie)
    .send({ ...VALID_BODY, salaryMin: 100000, salaryMax: 200000 });
  assert.equal(res.status, 201);
  const { posting } = res.body;
  assert.equal(posting.slug, 'react-developer');
  assert.equal(posting.status, 'active');
  assert.equal(posting.salaryCurrency, 'INR');
  assert.equal(posting.salaryMin, 100000);
  assert.ok(posting.postedAt);
  for (const field of ['id', 'title', 'description', 'descriptionPlain', 'location',
    'workplaceType', 'employmentType', 'status', 'createdAt', 'updatedAt']) {
    assert.ok(field in posting, `missing field ${field}`);
  }
  assert.equal('companyId' in posting, false); // owner field never exposed
});

// D5(d) — the Livo AI signup path: a second employer must be able to post.
test('POST twice for DIFFERENT companies → both return 201 (JobID:null regression)', async () => {
  const app = buildApp();
  const first = await onboardedCookie('e1');
  const second = await onboardedCookie('e2');
  const one = await request(app).post('/api/employer/jobs').set('Cookie', first.cookie).send(VALID_BODY);
  const two = await request(app).post('/api/employer/jobs').set('Cookie', second.cookie).send(VALID_BODY);
  assert.equal(one.status, 201);
  assert.equal(two.status, 201);
  assert.equal(one.body.posting.slug, 'react-developer');
  assert.equal(two.body.posting.slug, 'react-developer');
  assert.notEqual(one.body.posting.id, two.body.posting.id);
});

test('GET lists only this company, filters by status, excludes scraped jobs', async () => {
  const { cookie, company } = await onboardedCookie('b');
  const app = buildApp();
  await request(app).post('/api/employer/jobs').set('Cookie', cookie).send(VALID_BODY);
  await request(app).post('/api/employer/jobs').set('Cookie', cookie)
    .send({ ...VALID_BODY, title: 'Designer', status: 'draft' });
  // A scraped job (PascalCase, source:'scraped') sharing the companyId must not leak.
  const jobs = await col('jobs');
  await jobs.insertOne({ JobTitle: 'Scraped', Company: 'X', source: 'scraped', companyId: company._id, Status: 'active' });

  const other = await onboardedCookie('b2');
  await request(app).post('/api/employer/jobs').set('Cookie', other.cookie).send(VALID_BODY);

  const all = await request(app).get('/api/employer/jobs').set('Cookie', cookie);
  assert.equal(all.body.postings.length, 2);
  assert.equal(all.body.postings.some((posting) => posting.title === 'Scraped'), false);

  const drafts = await request(app).get('/api/employer/jobs?status=draft').set('Cookie', cookie);
  assert.equal(drafts.body.postings.length, 1);
  assert.equal(drafts.body.postings[0].title, 'Designer');
});

test('GET :postingId returns the single posting', async () => {
  const { cookie } = await onboardedCookie('c');
  const app = buildApp();
  const created = await request(app).post('/api/employer/jobs').set('Cookie', cookie).send(VALID_BODY);
  const res = await request(app).get(`/api/employer/jobs/${created.body.posting.id}`).set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.equal(res.body.posting.slug, 'react-developer');
});

test('close then reopen drives the status state machine', async () => {
  const { cookie } = await onboardedCookie('d');
  const app = buildApp();
  const created = await request(app).post('/api/employer/jobs').set('Cookie', cookie).send(VALID_BODY);
  const id = created.body.posting.id;
  const closed = await request(app).post(`/api/employer/jobs/${id}/close`).set('Cookie', cookie);
  assert.equal(closed.body.posting.status, 'closed');
  const reopened = await request(app).post(`/api/employer/jobs/${id}/reopen`).set('Cookie', cookie);
  assert.equal(reopened.body.posting.status, 'active');
});

// ── Chunk 3: role enforcement gating ─────────────────────────────────────────
let roleSeq = 0;
async function addRoleCookie(companyId, role, extra = {}) {
  roleSeq += 1;
  const user = await findOrCreateEmployerGoogleUser({ googleId: `gr-${role}-${roleSeq}`, email: `r${role}${roleSeq}@acme.com`, name: role, picture: null });
  await linkCompanyToEmployerUser(user._id, companyId);
  await insertCompanyMember({ companyId, employerUserId: user._id, role, isFounder: false, ...extra });
  return `jm_employer_token=${jwt.sign({ employerUserId: user._id.toString(), email: user.email }, EMPLOYER_JWT_SECRET)}`;
}

test('gating — posting create: 403 Interviewer, 201 Member', async () => {
  const { company } = await onboardedCookie('gpc');
  const interviewer = await addRoleCookie(company._id, 'interviewer');
  assert.equal((await request(buildApp()).post('/api/employer/jobs').set('Cookie', interviewer).send(VALID_BODY)).status, 403);
  const member = await addRoleCookie(company._id, 'member');
  assert.equal((await request(buildApp()).post('/api/employer/jobs').set('Cookie', member).send(VALID_BODY)).status, 201);
});

test('gating — posting close: 403 Interviewer, 200 Member', async () => {
  const { cookie, company } = await onboardedCookie('gpx');
  const created = await request(buildApp()).post('/api/employer/jobs').set('Cookie', cookie).send(VALID_BODY);
  const id = created.body.posting.id;
  const interviewer = await addRoleCookie(company._id, 'interviewer');
  assert.equal((await request(buildApp()).post(`/api/employer/jobs/${id}/close`).set('Cookie', interviewer).send()).status, 403);
  const member = await addRoleCookie(company._id, 'member');
  assert.equal((await request(buildApp()).post(`/api/employer/jobs/${id}/close`).set('Cookie', member).send()).status, 200);
});

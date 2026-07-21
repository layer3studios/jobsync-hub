// FILE: tests/api/employer-postings-routes-edge-cases.test.js
// Validation + multi-tenant security cases for /api/employer/jobs.
import './../_helpers/test-db.js';
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import jwt from 'jsonwebtoken';

import { dropCollections, closeTestDb } from '../_helpers/test-db.js';
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

function tokenFor(user) {
  return `jm_employer_token=${jwt.sign({ employerUserId: user._id.toString(), email: user.email }, EMPLOYER_JWT_SECRET)}`;
}

async function onboardedCookie(tag) {
  const user = await findOrCreateEmployerGoogleUser({ googleId: `g-${tag}`, email: `o${tag}@acme.com`, name: 'Owner', picture: null });
  const company = await createCompany({ name: `Acme ${tag}` }, user._id);
  await linkCompanyToEmployerUser(user._id, company._id);
  await insertCompanyMember({ companyId: company._id, employerUserId: user._id, role: 'founder', isFounder: true });
  return { cookie: tokenFor(user), company };
}

async function cookieWithoutCompany(tag) {
  const user = await findOrCreateEmployerGoogleUser({ googleId: `n-${tag}`, email: `n${tag}@acme.com`, name: 'Solo', picture: null });
  return tokenFor(user);
}

before(async () => { await reset(); });
beforeEach(async () => { await reset(); });
after(async () => { await closeTestDb(); });
async function reset() {
  await dropCollections('jobs', 'companies', 'company_members', 'employer_users');
  await ensureCompanyIndexes(); await ensureEmployerUserIndexes(); await ensureCompanyMemberIndexes(); await ensurePostingIndexes();
}

test('POST without a cookie → 401', async () => {
  const res = await request(buildApp()).post('/api/employer/jobs').send(VALID_BODY);
  assert.equal(res.status, 401);
});

test('POST without an onboarded company → 403 NO_COMPANY', async () => {
  const cookie = await cookieWithoutCompany('x');
  const res = await request(buildApp()).post('/api/employer/jobs').set('Cookie', cookie).send(VALID_BODY);
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'NO_COMPANY');
});

test('POST with a missing title → 400 INVALID_TITLE', async () => {
  const { cookie } = await onboardedCookie('a');
  const res = await request(buildApp()).post('/api/employer/jobs').set('Cookie', cookie)
    .send({ ...VALID_BODY, title: '' });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'INVALID_TITLE');
});

test('POST with a bad workplaceType → 400 INVALID_WORKPLACE_TYPE', async () => {
  const { cookie } = await onboardedCookie('b');
  const res = await request(buildApp()).post('/api/employer/jobs').set('Cookie', cookie)
    .send({ ...VALID_BODY, workplaceType: 'moon' });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'INVALID_WORKPLACE_TYPE');
});

test('GET :postingId across tenants → 404 POSTING_NOT_FOUND', async () => {
  const app = buildApp();
  const ownerA = await onboardedCookie('c');
  const created = await request(app).post('/api/employer/jobs').set('Cookie', ownerA.cookie).send(VALID_BODY);
  const ownerB = await onboardedCookie('d');
  const res = await request(app).get(`/api/employer/jobs/${created.body.posting.id}`).set('Cookie', ownerB.cookie);
  assert.equal(res.status, 404);
  assert.equal(res.body.code, 'POSTING_NOT_FOUND');
});

test('PATCH with an unknown key → 400 UNKNOWN_FIELD', async () => {
  const { cookie } = await onboardedCookie('e');
  const app = buildApp();
  const created = await request(app).post('/api/employer/jobs').set('Cookie', cookie).send(VALID_BODY);
  const res = await request(app).patch(`/api/employer/jobs/${created.body.posting.id}`)
    .set('Cookie', cookie).send({ priority: 'high' });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'UNKNOWN_FIELD');
});

test('PATCH attempting to set companyId → 400 UNKNOWN_FIELD, valid fields still patch', async () => {
  const { cookie } = await onboardedCookie('f');
  const app = buildApp();
  const created = await request(app).post('/api/employer/jobs').set('Cookie', cookie).send(VALID_BODY);
  const id = created.body.posting.id;
  const forged = await request(app).patch(`/api/employer/jobs/${id}`)
    .set('Cookie', cookie).send({ title: 'New Title', companyId: 'deadbeefdeadbeefdeadbeef' });
  assert.equal(forged.status, 400);
  assert.equal(forged.body.code, 'UNKNOWN_FIELD');
  // The posting is untouched and still reachable by its owner (companyId intact).
  const ok = await request(app).patch(`/api/employer/jobs/${id}`).set('Cookie', cookie).send({ title: 'Renamed' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.posting.title, 'Renamed');
});

test('PATCH salary applies and validates min <= max', async () => {
  const { cookie } = await onboardedCookie('g');
  const app = buildApp();
  const created = await request(app).post('/api/employer/jobs').set('Cookie', cookie).send(VALID_BODY);
  const id = created.body.posting.id;
  const ok = await request(app).patch(`/api/employer/jobs/${id}`).set('Cookie', cookie)
    .send({ salaryMin: 100000, salaryMax: 150000 });
  assert.equal(ok.body.posting.salaryMax, 150000);
  const bad = await request(app).patch(`/api/employer/jobs/${id}`).set('Cookie', cookie)
    .send({ salaryMin: 999999 });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, 'INVALID_SALARY');
});

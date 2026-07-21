// FILE: tests/api/employer-company-routes.test.js
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
import { createEmployerAuthRouter } from '../../src/api/employer/employer-auth-routes.js';
import employerCompanyRouter from '../../src/api/employer/employer-company-routes.js';
import {
  ensureCompanyIndexes, ensureEmployerUserIndexes, findOrCreateEmployerGoogleUser,
  ensureCompanyMemberIndexes, insertCompanyMember, linkCompanyToEmployerUser,
} from '../../src/models/employer/index.js';
import { col } from '../../src/Db/connection.js';

/** After onboarding (which does not yet create a membership), seed the creator as
 *  Founder so the newly role-gated GET/PATCH company routes admit them. */
async function seedFounderFor(email) {
  const user = await (await col('employer_users')).findOne({ email });
  await insertCompanyMember({ companyId: user.companyId, employerUserId: user._id, role: 'founder', isFounder: true });
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/employer/auth', createEmployerAuthRouter());
  app.use('/api/employer/company', requireEmployer, employerCompanyRouter);
  app.use(errorHandler);
  return app;
}

async function userCookie(tag) {
  const user = await findOrCreateEmployerGoogleUser({ googleId: `g-${tag}`, email: `o${tag}@acme.com`, name: 'Owner', picture: null });
  const token = jwt.sign({ employerUserId: user._id.toString(), email: user.email }, EMPLOYER_JWT_SECRET);
  return `jm_employer_token=${token}`;
}

before(async () => { await reset(); });
beforeEach(async () => { await reset(); });
after(async () => { await closeTestDb(); });
async function reset() {
  await dropCollections('companies', 'stages', 'archive_reasons', 'employer_users', 'company_members');
  await ensureCompanyIndexes(); await ensureEmployerUserIndexes(); await ensureCompanyMemberIndexes();
}

test('POST requires a cookie (401 without)', async () => {
  const res = await request(buildApp()).post('/api/employer/company').send({ name: 'Acme' });
  assert.equal(res.status, 401);
});

test('POST happy path returns the public company shape', async () => {
  const cookie = await userCookie('a');
  const res = await request(buildApp()).post('/api/employer/company')
    .set('Cookie', cookie).send({ name: 'Acme Agency', website: 'https://acme.com' });
  assert.equal(res.status, 200);
  assert.equal(res.body.company.slug, 'acme-agency');
  assert.equal(res.body.company.retentionDays, 365);
  assert.equal(res.body.company.id !== undefined, true);
});

test('POST without name → 400 INVALID_NAME', async () => {
  const cookie = await userCookie('b');
  const res = await request(buildApp()).post('/api/employer/company').set('Cookie', cookie).send({});
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'INVALID_NAME');
});

test('POST when already onboarded → 409 ALREADY_ONBOARDED', async () => {
  const cookie = await userCookie('c');
  const app = buildApp();
  await request(app).post('/api/employer/company').set('Cookie', cookie).send({ name: 'Acme' });
  const res = await request(app).post('/api/employer/company').set('Cookie', cookie).send({ name: 'Acme' });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'ALREADY_ONBOARDED');
});

test('GET returns 404 NO_COMPANY before onboarding, then the company after', async () => {
  const cookie = await userCookie('d');
  const app = buildApp();
  const before = await request(app).get('/api/employer/company').set('Cookie', cookie);
  assert.equal(before.status, 404);
  assert.equal(before.body.code, 'NO_COMPANY');
  await request(app).post('/api/employer/company').set('Cookie', cookie).send({ name: 'Bolt' });
  await seedFounderFor('od@acme.com');
  const after = await request(app).get('/api/employer/company').set('Cookie', cookie);
  assert.equal(after.status, 200);
  assert.equal(after.body.company.slug, 'bolt');
});

test('PATCH rejects a forged companyId key and updates valid fields from the session', async () => {
  const cookie = await userCookie('e');
  const app = buildApp();
  await request(app).post('/api/employer/company').set('Cookie', cookie).send({ name: 'Acme' });
  await seedFounderFor('oe@acme.com');
  const forged = await request(app).patch('/api/employer/company')
    .set('Cookie', cookie).send({ name: 'New', companyId: 'deadbeefdeadbeefdeadbeef' });
  assert.equal(forged.status, 400);
  assert.equal(forged.body.code, 'UNKNOWN_FIELD');
  const ok = await request(app).patch('/api/employer/company').set('Cookie', cookie).send({ retentionDays: 200 });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.company.retentionDays, 200);
});

test('GET /me returns company:null pre-onboarding and the company after', async () => {
  const cookie = await userCookie('f');
  const app = buildApp();
  const before = await request(app).get('/api/employer/auth/me').set('Cookie', cookie);
  assert.equal(before.status, 200);
  assert.equal(before.body.company, null);
  await request(app).post('/api/employer/company').set('Cookie', cookie).send({ name: 'Acme' });
  const after = await request(app).get('/api/employer/auth/me').set('Cookie', cookie);
  assert.equal(after.body.company.slug, 'acme');
  assert.equal(after.body.employerUser.email, 'of@acme.com');
});

// ── Chunk 3: role enforcement gating on company update ───────────────────────
let roleSeq = 0;
async function addRoleCookie(companyId, role) {
  roleSeq += 1;
  const user = await findOrCreateEmployerGoogleUser({ googleId: `gr-${role}-${roleSeq}`, email: `r${role}${roleSeq}@acme.com`, name: role, picture: null });
  await linkCompanyToEmployerUser(user._id, companyId);
  await insertCompanyMember({ companyId, employerUserId: user._id, role, isFounder: false });
  return `jm_employer_token=${jwt.sign({ employerUserId: user._id.toString(), email: user.email }, EMPLOYER_JWT_SECRET)}`;
}

test('gating — company update: 403 as Member, 200 as Founder (the claimer)', async () => {
  const cookie = await userCookie('gu');
  const app = buildApp();
  await request(app).post('/api/employer/company').set('Cookie', cookie).send({ name: 'GateCo' });
  await seedFounderFor('ogu@acme.com');
  const u = await (await col('employer_users')).findOne({ email: 'ogu@acme.com' });
  const memberCookie = await addRoleCookie(u.companyId, 'member');
  const denied = await request(app).patch('/api/employer/company').set('Cookie', memberCookie).send({ retentionDays: 200 });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.code, 'INSUFFICIENT_ROLE');
  const ok = await request(app).patch('/api/employer/company').set('Cookie', cookie).send({ retentionDays: 200 });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.company.retentionDays, 200);
});

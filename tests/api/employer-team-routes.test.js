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
import employerTeamRouter from '../../src/api/employer/employer-team-routes.js';
import {
  ensureEmployerUserIndexes, findOrCreateEmployerGoogleUser, linkCompanyToEmployerUser,
  ensureCompanyIndexes, createCompany,
  ensureCompanyMemberIndexes, insertCompanyMember,
} from '../../src/models/employer/index.js';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/employer/team', requireEmployer, requireEmployerCompany, employerTeamRouter);
  app.use(errorHandler);
  return app;
}

before(async () => { await reset(); });
beforeEach(async () => { await reset(); });
after(async () => { await closeTestDb(); });
async function reset() {
  await dropCollections('employer_users', 'companies', 'company_members');
  await ensureEmployerUserIndexes();
  await ensureCompanyIndexes();
  await ensureCompanyMemberIndexes();
}

function cookieFor(user) {
  const token = jwt.sign({ employerUserId: user._id.toString(), email: user.email }, EMPLOYER_JWT_SECRET);
  return `jm_employer_token=${token}`;
}

/** Create a user + company + membership at the given role; returns { user, cookie, companyId }. */
async function setup(tag, role) {
  let user = await findOrCreateEmployerGoogleUser({ googleId: `g-${tag}`, email: `${tag}@acme.com`, name: `User ${tag}`, picture: null });
  const company = await createCompany({ name: `Co ${tag}` }, user._id);
  await linkCompanyToEmployerUser(user._id, company._id);
  user = { ...user, companyId: company._id };
  await insertCompanyMember({ companyId: company._id, employerUserId: user._id, role, isFounder: role === 'founder' });
  return { user, cookie: cookieFor(user), companyId: company._id };
}

test('GET /team/members requires auth (401)', async () => {
  const res = await request(buildApp()).get('/api/employer/team/members');
  assert.equal(res.status, 401);
});

test('GET /team/members requires company (403 when session has no companyId)', async () => {
  const user = await findOrCreateEmployerGoogleUser({ googleId: 'g-noco', email: 'noco@acme.com', name: 'No Co', picture: null });
  const res = await request(buildApp()).get('/api/employer/team/members').set('Cookie', cookieFor(user));
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'NO_COMPANY');
});

test('GET /team/members with a Founder session returns the founder in the roster', async () => {
  const { cookie } = await setup('founder', 'founder');
  const res = await request(buildApp()).get('/api/employer/team/members').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.equal(res.body.members.length, 1);
  assert.equal(res.body.members[0].role, 'founder');
  assert.equal(res.body.members[0].isFounder, true);
  assert.equal(res.body.members[0].email, 'founder@acme.com');
});

test('GET /team/members with an Interviewer session succeeds (visibility open to all roles)', async () => {
  const { cookie } = await setup('intv', 'interviewer');
  const res = await request(buildApp()).get('/api/employer/team/members').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.equal(Array.isArray(res.body.members), true);
});

test('GET /team/invites with a Member session → 403 INSUFFICIENT_ROLE', async () => {
  const { cookie } = await setup('mem', 'member');
  const res = await request(buildApp()).get('/api/employer/team/invites').set('Cookie', cookie);
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'INSUFFICIENT_ROLE');
});

test('GET /team/invites with an Owner session → 200 with empty list (no invites exist yet)', async () => {
  const { cookie } = await setup('own', 'owner');
  const res = await request(buildApp()).get('/api/employer/team/invites').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.invites, []);
});

test('GET /team/invites with a Founder session → 200 with empty list', async () => {
  const { cookie } = await setup('f2', 'founder');
  const res = await request(buildApp()).get('/api/employer/team/invites').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.invites, []);
});

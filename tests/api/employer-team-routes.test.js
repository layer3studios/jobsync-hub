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
  ensureCompanyInviteIndexes,
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
  await dropCollections('employer_users', 'companies', 'company_members', 'company_invites');
  await ensureEmployerUserIndexes();
  await ensureCompanyIndexes();
  await ensureCompanyMemberIndexes();
  await ensureCompanyInviteIndexes();
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

// ─── Chunk 2: invite write endpoints (create / revoke / resend) ─────────────
const createInviteAs = (cookie, body) => request(buildApp()).post('/api/employer/team/invites').set('Cookie', cookie).send(body);

test('POST /invites: 401 without auth', async () => {
  const res = await request(buildApp()).post('/api/employer/team/invites').send({ email: 'x@acme.com', role: 'member' });
  assert.equal(res.status, 401);
});

test('POST /invites: 403 as Member', async () => {
  const { cookie } = await setup('m1', 'member');
  const res = await createInviteAs(cookie, { email: 'x@acme.com', role: 'member' });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'INSUFFICIENT_ROLE');
});

test('POST /invites: 403 as Interviewer', async () => {
  const { cookie } = await setup('i1', 'interviewer');
  const res = await createInviteAs(cookie, { email: 'x@acme.com', role: 'member' });
  assert.equal(res.status, 403);
});

test('POST /invites: 201 as Owner; inviteUrl contains the token', async () => {
  const { cookie } = await setup('o1', 'owner');
  const res = await createInviteAs(cookie, { email: 'teammate@acme.com', role: 'member' });
  assert.equal(res.status, 201);
  assert.ok(res.body.invite.token);
  assert.ok(res.body.inviteUrl.includes(res.body.invite.token));
});

test('POST /invites: 201 as Founder with role=owner', async () => {
  const { cookie } = await setup('f1', 'founder');
  const res = await createInviteAs(cookie, { email: 'newowner@acme.com', role: 'owner' });
  assert.equal(res.status, 201);
  assert.equal(res.body.invite.role, 'owner');
});

test('POST /invites: 409 on duplicate pending; includes existingInviteId', async () => {
  const { cookie } = await setup('o2', 'owner');
  const first = await createInviteAs(cookie, { email: 'dup@acme.com', role: 'member' });
  const res = await createInviteAs(cookie, { email: 'dup@acme.com', role: 'member' });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'INVITE_ALREADY_PENDING');
  assert.equal(res.body.existingInviteId, first.body.invite.id);
});

test('POST /invites: 409 ALREADY_MEMBER', async () => {
  const { cookie, companyId } = await setup('o3', 'owner');
  const mate = await findOrCreateEmployerGoogleUser({ googleId: 'g-mate', email: 'mate@acme.com', name: 'Mate', picture: null });
  await insertCompanyMember({ companyId, employerUserId: mate._id, role: 'member' });
  const res = await createInviteAs(cookie, { email: 'mate@acme.com', role: 'member' });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'ALREADY_MEMBER');
});

test('POST /invites: 400 INVALID_EMAIL / CANNOT_INVITE_SELF / INVALID_ROLE', async () => {
  const { cookie, user } = await setup('o4', 'owner');
  assert.equal((await createInviteAs(cookie, { email: 'bad', role: 'member' })).body.code, 'INVALID_EMAIL');
  assert.equal((await createInviteAs(cookie, { email: user.email, role: 'member' })).body.code, 'CANNOT_INVITE_SELF');
  assert.equal((await createInviteAs(cookie, { email: 'y@acme.com', role: 'founder' })).body.code, 'INVALID_ROLE');
});

test('DELETE /invites/:id: 401 without auth', async () => {
  const res = await request(buildApp()).delete('/api/employer/team/invites/deadbeefdeadbeefdeadbeef');
  assert.equal(res.status, 401);
});

test('DELETE /invites/:id: 403 as Member', async () => {
  const { cookie } = await setup('m2', 'member');
  const res = await request(buildApp()).delete('/api/employer/team/invites/deadbeefdeadbeefdeadbeef').set('Cookie', cookie);
  assert.equal(res.status, 403);
});

test('DELETE /invites/:id: 200 as Owner returns revoked invite', async () => {
  const { cookie } = await setup('o5', 'owner');
  const created = await createInviteAs(cookie, { email: 'rev@acme.com', role: 'member' });
  const res = await request(buildApp()).delete(`/api/employer/team/invites/${created.body.invite.id}`).set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.equal(res.body.invite.status, 'revoked');
});

test('DELETE /invites/:id: 404 for another company\'s invite (cross-tenant)', async () => {
  const a = await setup('oa', 'owner');
  const created = await createInviteAs(a.cookie, { email: 'ct@acme.com', role: 'member' });
  const b = await setup('ob', 'owner');
  const res = await request(buildApp()).delete(`/api/employer/team/invites/${created.body.invite.id}`).set('Cookie', b.cookie);
  assert.equal(res.status, 404);
  assert.equal(res.body.code, 'INVITE_NOT_FOUND');
});

test('POST /invites/:id/resend: 200 as Owner; new token differs from old', async () => {
  const { cookie } = await setup('o6', 'owner');
  const created = await createInviteAs(cookie, { email: 'res@acme.com', role: 'member' });
  const res = await request(buildApp()).post(`/api/employer/team/invites/${created.body.invite.id}/resend`).set('Cookie', cookie).send();
  assert.equal(res.status, 200);
  assert.notEqual(res.body.invite.token, created.body.invite.token);
  assert.ok(res.body.newInviteUrl.includes(res.body.invite.token));
});

test('POST /invites/:id/resend: 409 if invite already revoked', async () => {
  const { cookie } = await setup('o7', 'owner');
  const created = await createInviteAs(cookie, { email: 'res2@acme.com', role: 'member' });
  await request(buildApp()).delete(`/api/employer/team/invites/${created.body.invite.id}`).set('Cookie', cookie);
  const res = await request(buildApp()).post(`/api/employer/team/invites/${created.body.invite.id}/resend`).set('Cookie', cookie).send();
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'CANNOT_RESEND_NON_PENDING');
});

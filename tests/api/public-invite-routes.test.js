import './../_helpers/test-db.js';
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { ObjectId } from 'mongodb';

import { connectTestDb, dropCollections, closeTestDb } from '../_helpers/test-db.js';
import { EMPLOYER_JWT_SECRET } from '../../src/env.js';
import { errorHandler } from '../../src/middleware/error-handler-middleware.js';
import { requireEmployer } from '../../src/middleware/require-employer-middleware.js';
import publicInviteRouter from '../../src/api/public/public-invite-routes.js';
import { acceptRouter } from '../../src/api/employer/employer-team-routes.js';
import {
  ensureEmployerUserIndexes, findOrCreateEmployerGoogleUser,
  ensureCompanyMemberIndexes, insertCompanyMember, findCompanyMemberByCompanyAndUser,
  ensureCompanyInviteIndexes, insertCompanyInvite, findCompanyInviteByToken,
  generateInviteTokenUrlSafe, markInviteRevoked, markInviteAccepted,
} from '../../src/models/employer/index.js';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/public/invites', publicInviteRouter);
  app.use('/api/employer/team/invites/accept', requireEmployer, acceptRouter);
  app.use(errorHandler);
  return app;
}

const companyId = new ObjectId();
let inviter;

before(async () => { await reset(); });
beforeEach(async () => { await reset(); });
after(async () => { await closeTestDb(); });
async function reset() {
  await dropCollections('employer_users', 'companies', 'company_members', 'company_invites');
  await ensureEmployerUserIndexes(); await ensureCompanyMemberIndexes(); await ensureCompanyInviteIndexes();
  const db = await connectTestDb();
  await db.collection('companies').insertOne({ _id: companyId, name: 'Acme Inc' });
  inviter = await findOrCreateEmployerGoogleUser({ googleId: 'g-inv', email: 'inv@acme.com', name: 'Iris Inviter', picture: null });
}

async function seedInvite(over = {}) {
  const token = generateInviteTokenUrlSafe();
  const invite = await insertCompanyInvite({
    companyId, email: 'joiner@acme.com', role: 'member', token,
    invitedByEmployerUserId: inviter._id, expiresAt: new Date(Date.now() + 60_000), ...over,
  });
  return invite;
}
function cookieFor(user) {
  return `jm_employer_token=${jwt.sign({ employerUserId: user._id.toString(), email: user.email }, EMPLOYER_JWT_SECRET)}`;
}

// ─── preview ────────────────────────────────────────────────────────────────

test('GET /public/invites/:token: 200 sanitized (no token, no invitedByEmployerUserId; invitedByName only)', async () => {
  const invite = await seedInvite();
  const res = await request(buildApp()).get(`/api/public/invites/${invite.token}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.companyName, 'Acme Inc');
  assert.equal(res.body.invitedByName, 'Iris Inviter');
  assert.equal(res.body.role, 'member');
  assert.equal(res.body.token, undefined);
  assert.equal(res.body.invitedByEmployerUserId, undefined);
  assert.equal(res.body.acceptedAt, undefined);
});

test('GET /public/invites/:token: 404 for a nonexistent token', async () => {
  const res = await request(buildApp()).get('/api/public/invites/does-not-exist');
  assert.equal(res.status, 404);
  assert.equal(res.body.code, 'INVITE_NOT_FOUND');
});

test('GET /public/invites/:token: 410 status=expired for an expired invite', async () => {
  const invite = await seedInvite({ expiresAt: new Date(Date.now() - 1000) });
  const res = await request(buildApp()).get(`/api/public/invites/${invite.token}`);
  assert.equal(res.status, 410);
  assert.equal(res.body.status, 'expired');
});

test('GET /public/invites/:token: 410 status=revoked for a revoked invite', async () => {
  const invite = await seedInvite();
  await markInviteRevoked(invite._id);
  const res = await request(buildApp()).get(`/api/public/invites/${invite.token}`);
  assert.equal(res.status, 410);
  assert.equal(res.body.status, 'revoked');
});

test('GET /public/invites/:token: 410 status=accepted for an accepted invite', async () => {
  const invite = await seedInvite();
  await markInviteAccepted(invite._id, new ObjectId());
  const res = await request(buildApp()).get(`/api/public/invites/${invite.token}`);
  assert.equal(res.status, 410);
  assert.equal(res.body.status, 'accepted');
});

// ─── accept (auth, NOT company-scoped) ───────────────────────────────────────

async function joiner(email = 'joiner@acme.com') {
  return findOrCreateEmployerGoogleUser({ googleId: `g-${email}`, email, name: 'Jay Joiner', picture: null });
}

test('POST accept: 201 { member, redirectUrl } for a valid pending invite with matching email', async () => {
  const invite = await seedInvite();
  const user = await joiner();
  const res = await request(buildApp()).post('/api/employer/team/invites/accept').set('Cookie', cookieFor(user)).send({ token: invite.token });
  assert.equal(res.status, 201);
  assert.equal(res.body.member.role, 'member');
  assert.equal(res.body.redirectUrl, '/employer');
  assert.equal((await findCompanyInviteByToken(invite.token)).status, 'accepted');
});

test('POST accept: 403 INVITE_EMAIL_MISMATCH when the auth\'d email differs', async () => {
  const invite = await seedInvite();
  const user = await joiner('someone-else@acme.com');
  const res = await request(buildApp()).post('/api/employer/team/invites/accept').set('Cookie', cookieFor(user)).send({ token: invite.token });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'INVITE_EMAIL_MISMATCH');
});

test('POST accept: 410 INVITE_EXPIRED', async () => {
  const invite = await seedInvite({ expiresAt: new Date(Date.now() - 1000) });
  const user = await joiner();
  const res = await request(buildApp()).post('/api/employer/team/invites/accept').set('Cookie', cookieFor(user)).send({ token: invite.token });
  assert.equal(res.status, 410);
  assert.equal(res.body.code, 'INVITE_EXPIRED');
});

test('POST accept: 404 INVITE_NOT_FOUND', async () => {
  const user = await joiner();
  const res = await request(buildApp()).post('/api/employer/team/invites/accept').set('Cookie', cookieFor(user)).send({ token: 'nope' });
  assert.equal(res.status, 404);
  assert.equal(res.body.code, 'INVITE_NOT_FOUND');
});

test('POST accept: 409 ALREADY_MEMBER but marks the invite accepted anyway', async () => {
  const user = await joiner();
  await insertCompanyMember({ companyId, employerUserId: user._id, role: 'owner' });
  const invite = await seedInvite();
  const res = await request(buildApp()).post('/api/employer/team/invites/accept').set('Cookie', cookieFor(user)).send({ token: invite.token });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'ALREADY_MEMBER');
  assert.equal((await findCompanyInviteByToken(invite.token)).status, 'accepted');
  // No duplicate membership row created.
  assert.ok(await findCompanyMemberByCompanyAndUser(companyId, user._id));
});

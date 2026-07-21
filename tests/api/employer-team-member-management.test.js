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
const cookieFor = (user) => `jm_employer_token=${jwt.sign({ employerUserId: user._id.toString(), email: user.email }, EMPLOYER_JWT_SECRET)}`;

let seq = 0;
before(async () => { await reset(); });
beforeEach(async () => { await reset(); });
after(async () => { await closeTestDb(); });
async function reset() {
  await dropCollections('employer_users', 'companies', 'company_members');
  await ensureEmployerUserIndexes(); await ensureCompanyIndexes(); await ensureCompanyMemberIndexes();
}

/** A company whose creator is Founder. Returns { companyId, founder }. */
async function makeCompany() {
  seq += 1;
  const user = await findOrCreateEmployerGoogleUser({ googleId: `g-f${seq}`, email: `f${seq}@acme.com`, name: 'Founder', picture: null });
  const company = await createCompany({ name: `Acme ${seq}` }, user._id);
  await linkCompanyToEmployerUser(user._id, company._id);
  const m = await insertCompanyMember({ companyId: company._id, employerUserId: user._id, role: 'founder', isFounder: true });
  return { companyId: company._id, founder: { user, cookie: cookieFor(user), memberId: m._id.toString() } };
}
/** Add a member at a role to a company. Returns { user, cookie, memberId }. */
async function addMember(companyId, role, extra = {}) {
  seq += 1;
  const user = await findOrCreateEmployerGoogleUser({ googleId: `g-${role}${seq}`, email: `${role}${seq}@acme.com`, name: role, picture: null });
  await linkCompanyToEmployerUser(user._id, companyId);
  const m = await insertCompanyMember({ companyId, employerUserId: user._id, role, isFounder: false, ...extra });
  return { user, cookie: cookieFor(user), memberId: m._id.toString() };
}
const patchMemberReq = (cookie, id, body) => request(buildApp()).patch(`/api/employer/team/members/${id}`).set('Cookie', cookie ?? '').send(body);
const deleteMemberReq = (cookie, id) => request(buildApp()).delete(`/api/employer/team/members/${id}`).set('Cookie', cookie ?? '');
const transferReq = (cookie, body) => request(buildApp()).post('/api/employer/team/transfer-founder').set('Cookie', cookie ?? '').send(body);

// ── PATCH /members/:id ───────────────────────────────────────────────────────
test('PATCH /members/:id: 401 without cookie', async () => {
  const { companyId } = await makeCompany();
  const target = await addMember(companyId, 'member');
  const res = await request(buildApp()).patch(`/api/employer/team/members/${target.memberId}`).send({ role: 'interviewer' });
  assert.equal(res.status, 401);
});
test('PATCH /members/:id: 403 as Member', async () => {
  const { companyId } = await makeCompany();
  const actor = await addMember(companyId, 'member');
  const target = await addMember(companyId, 'interviewer');
  assert.equal((await patchMemberReq(actor.cookie, target.memberId, { role: 'member' })).status, 403);
});
test('PATCH /members/:id: 403 as Interviewer', async () => {
  const { companyId } = await makeCompany();
  const actor = await addMember(companyId, 'interviewer');
  const target = await addMember(companyId, 'member');
  assert.equal((await patchMemberReq(actor.cookie, target.memberId, { role: 'interviewer' })).status, 403);
});
test('PATCH /members/:id: 200 as Owner changing a Member to Interviewer', async () => {
  const { companyId } = await makeCompany();
  const actor = await addMember(companyId, 'owner');
  const target = await addMember(companyId, 'member');
  const res = await patchMemberReq(actor.cookie, target.memberId, { role: 'interviewer' });
  assert.equal(res.status, 200);
  assert.equal(res.body.member.role, 'interviewer');
});
test('PATCH /members/:id: 200 as Founder', async () => {
  const { companyId, founder } = await makeCompany();
  const target = await addMember(companyId, 'member');
  const res = await patchMemberReq(founder.cookie, target.memberId, { role: 'owner' });
  assert.equal(res.status, 200);
  assert.equal(res.body.member.role, 'owner');
});
test('PATCH /members/:id: 400 SELF_ROLE_CHANGE_FORBIDDEN when patching self', async () => {
  const { companyId } = await makeCompany();
  const actor = await addMember(companyId, 'owner');
  const res = await patchMemberReq(actor.cookie, actor.memberId, { role: 'member' });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'SELF_ROLE_CHANGE_FORBIDDEN');
});
test('PATCH /members/:id: 403 CANNOT_PATCH_FOUNDER when patching the Founder', async () => {
  const { companyId, founder } = await makeCompany();
  const actor = await addMember(companyId, 'owner');
  const res = await patchMemberReq(actor.cookie, founder.memberId, { role: 'member' });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'CANNOT_PATCH_FOUNDER');
});

// ── DELETE /members/:id ──────────────────────────────────────────────────────
test('DELETE /members/:id: 401 without cookie', async () => {
  const { companyId } = await makeCompany();
  const target = await addMember(companyId, 'member');
  assert.equal((await request(buildApp()).delete(`/api/employer/team/members/${target.memberId}`)).status, 401);
});
test('DELETE /members/:id: 403 as Member removing another member', async () => {
  const { companyId } = await makeCompany();
  const actor = await addMember(companyId, 'member');
  const target = await addMember(companyId, 'interviewer');
  assert.equal((await deleteMemberReq(actor.cookie, target.memberId)).status, 403);
});
test('DELETE /members/:id: 200 Owner removes Member', async () => {
  const { companyId } = await makeCompany();
  const actor = await addMember(companyId, 'owner');
  const target = await addMember(companyId, 'member');
  const res = await deleteMemberReq(actor.cookie, target.memberId);
  assert.equal(res.status, 200);
  assert.equal(res.body.removed, true);
});
test('DELETE /members/:id: 200 Member removes self', async () => {
  const { companyId } = await makeCompany();
  const actor = await addMember(companyId, 'member');
  assert.equal((await deleteMemberReq(actor.cookie, actor.memberId)).status, 200);
});
test('DELETE /members/:id: 403 CANNOT_REMOVE_FOUNDER when Owner removes the Founder', async () => {
  const { companyId, founder } = await makeCompany();
  const actor = await addMember(companyId, 'owner');
  const res = await deleteMemberReq(actor.cookie, founder.memberId);
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'CANNOT_REMOVE_FOUNDER');
});
test('DELETE /members/:id: 403 CANNOT_REMOVE_SELF_FOUNDER when Founder self-removes', async () => {
  const { founder } = await makeCompany();
  const res = await deleteMemberReq(founder.cookie, founder.memberId);
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'CANNOT_REMOVE_SELF_FOUNDER');
});
test('DELETE /members/:id: 404 cross-tenant', async () => {
  const a = await makeCompany();
  const targetA = await addMember(a.companyId, 'member');
  const b = await makeCompany();
  const res = await deleteMemberReq(b.founder.cookie, targetA.memberId);
  assert.equal(res.status, 404);
  assert.equal(res.body.code, 'MEMBER_NOT_FOUND');
});

// ── POST /transfer-founder ───────────────────────────────────────────────────
test('POST /transfer-founder: 401 without cookie', async () => {
  const { companyId } = await makeCompany();
  const owner = await addMember(companyId, 'owner');
  assert.equal((await transferReq(null, { toMemberId: owner.memberId })).status, 401);
});
test('POST /transfer-founder: 403 as Owner (not Founder)', async () => {
  const { companyId } = await makeCompany();
  const actor = await addMember(companyId, 'owner');
  const target = await addMember(companyId, 'owner');
  const res = await transferReq(actor.cookie, { toMemberId: target.memberId });
  assert.equal(res.status, 403);
});
test('POST /transfer-founder: 200 as Founder — target becomes Founder, actor becomes Owner', async () => {
  const { companyId, founder } = await makeCompany();
  const target = await addMember(companyId, 'owner');
  const res = await transferReq(founder.cookie, { toMemberId: target.memberId });
  assert.equal(res.status, 200);
  const roster = await request(buildApp()).get('/api/employer/team/members').set('Cookie', founder.cookie);
  const byId = Object.fromEntries(roster.body.members.map((m) => [m.id, m]));
  assert.equal(byId[target.memberId].isFounder, true);
  assert.equal(byId[founder.memberId].isFounder, false);
});
test('POST /transfer-founder: 400 TARGET_NOT_OWNER when target is a Member', async () => {
  const { companyId, founder } = await makeCompany();
  const target = await addMember(companyId, 'member');
  const res = await transferReq(founder.cookie, { toMemberId: target.memberId });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'TARGET_NOT_OWNER');
});
test('POST /transfer-founder: 400 CANNOT_TRANSFER_TO_SELF', async () => {
  const { founder } = await makeCompany();
  const res = await transferReq(founder.cookie, { toMemberId: founder.memberId });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'CANNOT_TRANSFER_TO_SELF');
});

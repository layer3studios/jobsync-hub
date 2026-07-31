// FILE: tests/api/employer-interview-routes.test.js
// Role gating + tenant isolation for /api/employer interview routes. Email
// sending is naturally inert under test (no RESEND_API_KEY → disabled path).
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
import employerInterviewRouter from '../../src/api/employer/employer-interview-routes.js';
import {
  ensureCompanyIndexes, ensureEmployerUserIndexes, ensureCompanyMemberIndexes,
  findOrCreateEmployerGoogleUser, createCompany, linkCompanyToEmployerUser, insertCompanyMember,
} from '../../src/models/employer/index.js';
import { ensureInterviewIndexes } from '../../src/models/interview/index.js';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/employer', requireEmployer, requireEmployerCompany, employerInterviewRouter);
  app.use(errorHandler);
  return app;
}

const HOURS_FROM_NOW = (hours) => new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();

let founder; let member; let interviewer; let company; let applicationId;

async function userWithRole(tag, role, companyId) {
  const user = await findOrCreateEmployerGoogleUser({ googleId: `g-${tag}`, email: `${tag}@acme.com`, name: tag, picture: null });
  await linkCompanyToEmployerUser(user._id, companyId);
  await insertCompanyMember({ companyId, employerUserId: user._id, role, isFounder: role === 'founder' });
  return { user, cookie: `jm_employer_token=${jwt.sign({ employerUserId: user._id.toString(), email: user.email }, EMPLOYER_JWT_SECRET)}` };
}

before(async () => { await reset(); });
beforeEach(async () => { await reset(); });
after(async () => { await closeTestDb(); });
async function reset() {
  await dropCollections('interviews', 'companies', 'jobs', 'contacts', 'employer_users', 'company_members', 'applications', 'audit_log');
  await ensureCompanyIndexes(); await ensureEmployerUserIndexes(); await ensureCompanyMemberIndexes(); await ensureInterviewIndexes();

  const founderUser = await findOrCreateEmployerGoogleUser({ googleId: 'g-founder', email: 'founder@acme.com', name: 'Founder', picture: null });
  company = await createCompany({ name: 'Acme' }, founderUser._id);
  await linkCompanyToEmployerUser(founderUser._id, company._id);
  await insertCompanyMember({ companyId: company._id, employerUserId: founderUser._id, role: 'founder', isFounder: true });
  founder = { user: founderUser, cookie: `jm_employer_token=${jwt.sign({ employerUserId: founderUser._id.toString(), email: founderUser.email }, EMPLOYER_JWT_SECRET)}` };
  member = await userWithRole('member', 'member', company._id);
  interviewer = await userWithRole('interviewer', 'interviewer', company._id);

  const postingId = new ObjectId(); const contactId = new ObjectId(); applicationId = new ObjectId();
  await (await col('jobs')).insertOne({ _id: postingId, source: 'native', companyId: company._id, title: 'Backend Engineer' });
  await (await col('contacts')).insertOne({ _id: contactId, companyId: company._id, email: 'asha@example.com', fullName: 'Asha Rao' });
  await (await col('applications')).insertOne({ _id: applicationId, companyId: company._id, jobId: postingId, contactId });
}

function proposeBody() {
  return {
    proposedSlots: [
      { startAtUtc: HOURS_FROM_NOW(24), durationMinutes: 45 },
      { startAtUtc: HOURS_FROM_NOW(48), durationMinutes: 45 },
    ],
    durationMinutes: 45, mode: 'video', meetingUrl: 'https://meet.jobmesh.in/room/abc',
  };
}

function propose(cookie, appId = applicationId) {
  return request(buildApp()).post(`/api/employer/applicants/${appId}/interviews`).set('Cookie', cookie).send(proposeBody());
}

test('propose returns 201 with the interview and no bookingToken', async () => {
  const res = await propose(member.cookie);
  assert.equal(res.status, 201);
  assert.equal(res.body.data.status, 'proposed');
  assert.equal(res.body.data.mode, 'video');
  assert.equal(res.body.data.bookingToken, undefined);
});

test('propose with another company\'s applicationId returns 404', async () => {
  const otherFounderUser = await findOrCreateEmployerGoogleUser({ googleId: 'g-other', email: 'other@rival.com', name: 'Other', picture: null });
  const otherCompany = await createCompany({ name: 'Rival' }, otherFounderUser._id);
  await linkCompanyToEmployerUser(otherFounderUser._id, otherCompany._id);
  await insertCompanyMember({ companyId: otherCompany._id, employerUserId: otherFounderUser._id, role: 'founder', isFounder: true });
  const otherCookie = `jm_employer_token=${jwt.sign({ employerUserId: otherFounderUser._id.toString(), email: otherFounderUser.email }, EMPLOYER_JWT_SECRET)}`;
  const res = await propose(otherCookie);
  assert.equal(res.status, 404);
  assert.equal(res.body.code, 'APPLICATION_NOT_FOUND');
});

test('interviewer gets 403 on propose/reschedule/cancel but 200 on GET list', async () => {
  const created = await propose(member.cookie);
  const interviewId = created.body.data.id;

  const proposeRes = await propose(interviewer.cookie, new ObjectId().toString());
  assert.equal(proposeRes.status, 403);
  assert.equal(proposeRes.body.code, 'INSUFFICIENT_ROLE');

  const rescheduleRes = await request(buildApp()).post(`/api/employer/interviews/${interviewId}/reschedule`)
    .set('Cookie', interviewer.cookie).send({ proposedSlots: proposeBody().proposedSlots });
  assert.equal(rescheduleRes.status, 403);

  const cancelRes = await request(buildApp()).post(`/api/employer/interviews/${interviewId}/cancel`)
    .set('Cookie', interviewer.cookie).send({ cancelReason: 'x' });
  assert.equal(cancelRes.status, 403);

  const listRes = await request(buildApp()).get(`/api/employer/applicants/${applicationId}/interviews`).set('Cookie', interviewer.cookie);
  assert.equal(listRes.status, 200);
  assert.equal(listRes.body.data.length, 1);
});

test('member gets 200/201 on all four routes', async () => {
  const created = await propose(member.cookie);
  assert.equal(created.status, 201);
  const interviewId = created.body.data.id;

  const listRes = await request(buildApp()).get(`/api/employer/applicants/${applicationId}/interviews`).set('Cookie', member.cookie);
  assert.equal(listRes.status, 200);

  // Reschedule requires a booked interview — book via the model directly.
  const { bookInterviewSlot } = await import('../../src/models/interview/index.js');
  const stored = await (await col('interviews')).findOne({ _id: new ObjectId(interviewId) });
  await bookInterviewSlot(stored.bookingToken, 0);

  const rescheduleRes = await request(buildApp()).post(`/api/employer/interviews/${interviewId}/reschedule`)
    .set('Cookie', member.cookie).send({ proposedSlots: proposeBody().proposedSlots });
  assert.equal(rescheduleRes.status, 200);
  assert.equal(rescheduleRes.body.data.status, 'proposed');

  const cancelRes = await request(buildApp()).post(`/api/employer/interviews/${interviewId}/cancel`)
    .set('Cookie', member.cookie).send({ cancelReason: 'position filled' });
  assert.equal(cancelRes.status, 200);
  assert.equal(cancelRes.body.data.status, 'cancelled');
});

test('cancel on another company\'s interviewId returns 404, never 403', async () => {
  const created = await propose(member.cookie);
  const interviewId = created.body.data.id;
  const otherFounderUser = await findOrCreateEmployerGoogleUser({ googleId: 'g-other2', email: 'other2@rival.com', name: 'Other2', picture: null });
  const otherCompany = await createCompany({ name: 'Rival2' }, otherFounderUser._id);
  await linkCompanyToEmployerUser(otherFounderUser._id, otherCompany._id);
  await insertCompanyMember({ companyId: otherCompany._id, employerUserId: otherFounderUser._id, role: 'founder', isFounder: true });
  const otherCookie = `jm_employer_token=${jwt.sign({ employerUserId: otherFounderUser._id.toString(), email: otherFounderUser.email }, EMPLOYER_JWT_SECRET)}`;

  const res = await request(buildApp()).post(`/api/employer/interviews/${interviewId}/cancel`)
    .set('Cookie', otherCookie).send({ cancelReason: 'nope' });
  assert.equal(res.status, 404);
  assert.equal(res.body.code, 'INTERVIEW_NOT_FOUND');
});

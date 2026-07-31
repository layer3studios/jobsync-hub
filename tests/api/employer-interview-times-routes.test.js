// FILE: tests/api/employer-interview-times-routes.test.js
// HTTP surface for posting interview defaults + the availability pool.
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
import employerInterviewTimesRouter from '../../src/api/employer/employer-interview-times-routes.js';
import {
  ensureCompanyIndexes, ensureEmployerUserIndexes, ensureCompanyMemberIndexes,
  findOrCreateEmployerGoogleUser, createCompany, linkCompanyToEmployerUser, insertCompanyMember,
} from '../../src/models/employer/index.js';
import { ensureInterviewTimeIndexes, bookTimeAtomically, interviewTimesCol } from '../../src/models/interview/index.js';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/employer/jobs', requireEmployer, requireEmployerCompany, employerInterviewTimesRouter);
  app.use(errorHandler);
  return app;
}

const HOURS = (n) => new Date(Date.now() + n * 60 * 60 * 1000).toISOString();
let member; let company; let postingId;

before(async () => { await reset(); });
beforeEach(async () => { await reset(); });
after(async () => { await closeTestDb(); });
async function reset() {
  await dropCollections('interview_times', 'companies', 'jobs', 'employer_users', 'company_members');
  await ensureCompanyIndexes(); await ensureEmployerUserIndexes(); await ensureCompanyMemberIndexes(); await ensureInterviewTimeIndexes();
  const user = await findOrCreateEmployerGoogleUser({ googleId: 'g-m', email: 'm@acme.com', name: 'Member', picture: null });
  company = await createCompany({ name: 'Acme' }, user._id);
  await linkCompanyToEmployerUser(user._id, company._id);
  await insertCompanyMember({ companyId: company._id, employerUserId: user._id, role: 'member' });
  member = { user, cookie: `jm_employer_token=${jwt.sign({ employerUserId: user._id.toString(), email: user.email }, EMPLOYER_JWT_SECRET)}` };
  postingId = new ObjectId();
  await (await col('jobs')).insertOne({ _id: postingId, source: 'native', companyId: company._id, title: 'Backend Engineer', status: 'active' });
}

const DEFAULTS_BODY = { meetingUrl: 'https://meet.acme.in/x', durationMinutes: 45, mode: 'video', locationText: null };
const base = () => `/api/employer/jobs/${postingId}`;

async function putDefaults() {
  return request(buildApp()).put(`${base()}/interview-defaults`).set('Cookie', member.cookie).send(DEFAULTS_BODY);
}

test('PUT interview-defaults validates and stores the sub-document', async () => {
  const res = await putDefaults();
  assert.equal(res.status, 200);
  assert.equal(res.body.data.interviewDefaults.meetingUrl, 'https://meet.acme.in/x');
  assert.equal(res.body.data.interviewDefaults.timezoneId, 'Asia/Kolkata');
  const bad = await request(buildApp()).put(`${base()}/interview-defaults`).set('Cookie', member.cookie)
    .send({ ...DEFAULTS_BODY, durationMinutes: 7 });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, 'INVALID_DURATION');
});

test('POST interview-times inserts, rejects past times and empty arrays', async () => {
  await putDefaults();
  const res = await request(buildApp()).post(`${base()}/interview-times`).set('Cookie', member.cookie)
    .send({ times: [{ startAtUtc: HOURS(24) }, { startAtUtc: HOURS(48) }] });
  assert.equal(res.status, 201);
  assert.equal(res.body.data.insertedCount, 2);

  const past = await request(buildApp()).post(`${base()}/interview-times`).set('Cookie', member.cookie)
    .send({ times: [{ startAtUtc: '2020-01-01T00:00:00Z' }] });
  assert.equal(past.status, 400);
  const empty = await request(buildApp()).post(`${base()}/interview-times`).set('Cookie', member.cookie).send({ times: [] });
  assert.equal(empty.status, 400);
});

test('DELETE interview-times cancels an available time, 409 for a booked one', async () => {
  await putDefaults();
  await request(buildApp()).post(`${base()}/interview-times`).set('Cookie', member.cookie)
    .send({ times: [{ startAtUtc: HOURS(24) }, { startAtUtc: HOURS(48) }] });
  const rows = await (await interviewTimesCol()).find({ postingId }).sort({ startAtUtc: 1 }).toArray();
  await bookTimeAtomically(rows[1]._id, new ObjectId(), new ObjectId());

  const removed = await request(buildApp()).delete(`${base()}/interview-times/${rows[0]._id}`).set('Cookie', member.cookie);
  assert.equal(removed.status, 200);
  assert.equal(removed.body.data.status, 'cancelled');
  const booked = await request(buildApp()).delete(`${base()}/interview-times/${rows[1]._id}`).set('Cookie', member.cookie);
  assert.equal(booked.status, 409);
});

test('GET interview-times lists with status filter; GET count returns availableCount', async () => {
  await putDefaults();
  await request(buildApp()).post(`${base()}/interview-times`).set('Cookie', member.cookie)
    .send({ times: [{ startAtUtc: HOURS(24) }, { startAtUtc: HOURS(48) }] });
  const rows = await (await interviewTimesCol()).find({ postingId }).toArray();
  await bookTimeAtomically(rows[0]._id, new ObjectId(), new ObjectId());

  const list = await request(buildApp()).get(`${base()}/interview-times?status=available`).set('Cookie', member.cookie);
  assert.equal(list.status, 200);
  assert.equal(list.body.data.length, 1);
  const count = await request(buildApp()).get(`${base()}/interview-times/count`).set('Cookie', member.cookie);
  assert.equal(count.status, 200);
  assert.deepEqual(count.body.data, { availableCount: 1 });
});

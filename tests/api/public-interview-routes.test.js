// FILE: tests/api/public-interview-routes.test.js
// Unauthenticated booking surface: no auth cookie anywhere in this file — that
// IS part of what it verifies. Leak assertions run on the serialized response.
import './../_helpers/test-db.js';
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { ObjectId } from 'mongodb';

import { dropCollections, closeTestDb } from '../_helpers/test-db.js';
import { col } from '../../src/Db/connection.js';
import { errorHandler } from '../../src/middleware/error-handler-middleware.js';
import publicInterviewRouter from '../../src/api/public/public-interview-routes.js';
import {
  ensureInterviewIndexes, createInterviewForCompany, interviewsCol,
} from '../../src/models/interview/index.js';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/public', publicInterviewRouter);
  app.use(errorHandler);
  return app;
}

const COMPANY_A = new ObjectId();
const CREATOR = new ObjectId();
const HOURS_FROM_NOW = (hours) => new Date(Date.now() + hours * 60 * 60 * 1000);

let postingId; let contactId;

before(async () => { await reset(); });
beforeEach(async () => { await reset(); });
after(async () => { await closeTestDb(); });
async function reset() {
  await dropCollections('interviews', 'interview_times', 'interview_reminder_jobs', 'companies', 'jobs', 'contacts', 'employer_users');
  await ensureInterviewIndexes();
  postingId = new ObjectId(); contactId = new ObjectId();
  await (await col('companies')).insertOne({ _id: COMPANY_A, name: 'Acme', logoUrl: 'https://cdn.acme.in/logo.png' });
  await (await col('jobs')).insertOne({ _id: postingId, source: 'native', companyId: COMPANY_A, title: 'Backend Engineer' });
  await (await col('contacts')).insertOne({ _id: contactId, companyId: COMPANY_A, email: 'asha@example.com', fullName: 'Asha Rao' });
  await (await col('employer_users')).insertOne({ _id: CREATOR, email: 'ravi@acme.in', name: 'Ravi' });
}

function createInterview(overrides = {}) {
  return createInterviewForCompany(COMPANY_A, {
    applicationId: new ObjectId(), postingId, contactId,
    proposedSlots: [
      { startAtUtc: HOURS_FROM_NOW(24), durationMinutes: 45 },
      { startAtUtc: HOURS_FROM_NOW(48), durationMinutes: 45 },
    ],
    durationMinutes: 45, mode: 'video', meetingUrl: 'https://meet.acme.in/room/x',
    interviewerEmployerUserIds: [], ...overrides,
  }, CREATOR);
}

test('GET booking page: 200 with no auth cookie, and no internal identifiers leak', async () => {
  const interview = await createInterview();
  const res = await request(buildApp()).get(`/api/public/interviews/${interview.bookingToken}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.data.companyName, 'Acme');
  assert.equal(res.body.data.postingTitle, 'Backend Engineer');
  assert.equal(res.body.data.companyLogoUrl, 'https://cdn.acme.in/logo.png');
  const serialized = JSON.stringify(res.body);
  for (const [label, value] of [
    ['companyId', COMPANY_A.toString()],
    ['applicationId', interview.applicationId.toString()],
    ['contactId', contactId.toString()],
    ['calendarUid', interview.calendarUid],
    ['bookingToken', interview.bookingToken],
  ]) {
    assert.equal(serialized.includes(value), false, `${label} leaked in the public response`);
  }
});

test('GET with an unknown token returns 404 with NOTHING but a code; expired 410 carries the company name', async () => {
  const unknown = await request(buildApp()).get('/api/public/interviews/definitely-unknown-token');
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error.code, 'BOOKING_TOKEN_INVALID');
  // Bare by design: an unknown and a replaced token must be indistinguishable.
  assert.deepEqual(Object.keys(unknown.body), ['error']);
  assert.deepEqual(Object.keys(unknown.body.error).sort(), ['code', 'message']);

  const interview = await createInterview();
  await (await interviewsCol()).updateOne(
    { _id: interview._id },
    { $set: { bookingTokenExpiresAt: new Date(Date.now() - 1000) } },
  );
  const expired = await request(buildApp()).get(`/api/public/interviews/${interview.bookingToken}`);
  assert.equal(expired.status, 410);
  assert.equal(expired.body.error.code, 'BOOKING_TOKEN_EXPIRED');
  assert.equal(expired.body.error.companyName, 'Acme');
  assert.equal(expired.body.error.postingTitle, undefined);
});

test('POST book twice: first 200, second 409', async () => {
  const interview = await createInterview();
  const app = buildApp();
  const first = await request(app).post(`/api/public/interviews/${interview.bookingToken}/book`).send({ slotIndex: 0 });
  assert.equal(first.status, 200);
  assert.equal(first.body.data.status, 'scheduled');
  assert.equal(JSON.stringify(first.body).includes(interview.bookingToken), false, 'bookingToken leaked');

  const second = await request(app).post(`/api/public/interviews/${interview.bookingToken}/book`).send({ slotIndex: 0 });
  assert.equal(second.status, 409);
  assert.equal(second.body.error.code, 'INTERVIEW_NOT_PROPOSED');
});

test('pool booking end-to-end: GET carries times, POST with timeId books; slotIndex is rejected', async () => {
  const { addTimesForPosting } = await import('../../src/models/interview/interview-time-model.js');
  await (await col('jobs')).updateOne({ _id: postingId }, { $set: {
    interviewDefaults: { meetingUrl: 'https://meet.acme.in/room/x', durationMinutes: 45, mode: 'video', locationText: null, timezoneId: 'Asia/Kolkata' },
  } });
  await addTimesForPosting(COMPANY_A, postingId, [{ startAtUtc: HOURS_FROM_NOW(48) }], {
    meetingUrl: 'https://meet.acme.in/room/x', durationMinutes: 45, mode: 'video', locationText: null, timezoneId: 'Asia/Kolkata',
  });
  const interview = await createInterview({ source: 'pool', proposedSlots: [] });
  const app = buildApp();

  const page = await request(app).get(`/api/public/interviews/${interview.bookingToken}`);
  assert.equal(page.status, 200);
  assert.equal(page.body.data.times.length, 1);
  assert.deepEqual(Object.keys(page.body.data.times[0]).sort(), ['durationMinutes', 'id', 'startAtUtc', 'timezoneId']);

  const wrongBody = await request(app).post(`/api/public/interviews/${interview.bookingToken}/book`).send({ slotIndex: 0 });
  assert.equal(wrongBody.status, 400);
  assert.equal(wrongBody.body.error.code, 'POOL_REQUIRES_TIME_ID');

  const booked = await request(app).post(`/api/public/interviews/${interview.bookingToken}/book`).send({ timeId: page.body.data.times[0].id });
  assert.equal(booked.status, 200);
  assert.equal(booked.body.data.status, 'scheduled');

  const again = await request(app).post(`/api/public/interviews/${interview.bookingToken}/book`).send({ timeId: page.body.data.times[0].id });
  assert.equal(again.status, 409);
});

test('POST book with slotIndex 99 returns 400', async () => {
  const interview = await createInterview();
  const res = await request(buildApp()).post(`/api/public/interviews/${interview.bookingToken}/book`).send({ slotIndex: 99 });
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'INVALID_SLOT');
});

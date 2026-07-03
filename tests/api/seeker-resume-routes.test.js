import './../_helpers/test-db.js';
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { ObjectId } from 'mongodb';

import { dropCollections, closeTestDb } from '../_helpers/test-db.js';
import { col } from '../../src/Db/connection.js';
import { JWT_SECRET } from '../../src/env.js';
import { errorHandler } from '../../src/middleware/error-handler-middleware.js';
import { requireSeeker } from '../../src/middleware/require-seeker-middleware.js';
import { requireConsentForPurpose } from '../../src/middleware/require-consent-middleware.js';
import resumeRouter from '../../src/api/seeker/seeker-resume-routes.js';
import { ensureResumeParseJobIndexes, insertResumeParseJob } from '../../src/models/seeker/resume-parse-job-model.js';
import { initGemma } from '../../src/gemma/index.js';

const USER = new ObjectId();
const OTHER = new ObjectId();
const originalFetch = globalThis.fetch;
const LONG = 'Backend engineer with deep experience building distributed systems in Node.js, MongoDB, '
  + 'and Kubernetes across fintech and ecommerce companies throughout India for many years now. '
  + 'Led platform teams, owned reliability, and mentored engineers across multiple product lines here.';

function makePdf(body) {
  const lines = body.match(/.{1,60}/g) || [body];
  const content = `BT /F1 12 Tf 40 750 Td ${lines.map((l) => `(${l}) Tj 0 -16 Td`).join(' ')} ET`;
  return Buffer.from(
    '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n'
    + '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n'
    + `4 0 obj<</Length ${content.length}>>stream\n${content}\nendstream endobj\n`
    + '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\nxref\n0 6\n0000000000 65535 f \ntrailer<</Root 1 0 R/Size 6>>\nstartxref\n0\n%%EOF',
    'latin1',
  );
}
function cookie() { return `tj_token=${jwt.sign({ userId: USER.toString(), email: 's@x.com' }, JWT_SECRET)}`; }
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/seeker/resume', requireSeeker, requireConsentForPurpose('resume_parsing'), resumeRouter);
  app.use(errorHandler);
  return app;
}
async function grantConsent() {
  const consents = await col('consents');
  await consents.insertOne({ userId: USER, purpose: 'resume_parsing', withdrawnAt: null, grantedAt: new Date() });
}

before(async () => { await reset(); });
beforeEach(async () => { await reset(); });
after(async () => { globalThis.fetch = originalFetch; initGemma(''); await closeTestDb(); });
async function reset() {
  await dropCollections('users', 'consents', 'resume_parse_jobs');
  await ensureResumeParseJobIndexes();
  const users = await col('users');
  await users.insertOne({ _id: USER, name: 'A', appliedJobs: [] });
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"fullName":"Asha"}' }] } }] }), text: async () => '' });
  initGemma('fake-key-1');
}

test('POST /upload without auth → 401', async () => {
  const res = await request(buildApp()).post('/api/seeker/resume/upload').attach('resume', makePdf(LONG), { filename: 'r.pdf', contentType: 'application/pdf' });
  assert.equal(res.status, 401);
});

test('POST /upload without consent → 403 CONSENT_REQUIRED', async () => {
  const res = await request(buildApp()).post('/api/seeker/resume/upload').set('Cookie', cookie())
    .attach('resume', makePdf(LONG), { filename: 'r.pdf', contentType: 'application/pdf' });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'CONSENT_REQUIRED');
});

test('POST /upload with consent + valid PDF → 200 { jobId, status: queued }', async () => {
  await grantConsent();
  const res = await request(buildApp()).post('/api/seeker/resume/upload').set('Cookie', cookie())
    .attach('resume', makePdf(LONG), { filename: 'r.pdf', contentType: 'application/pdf' });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'queued');
  assert.ok(res.body.jobId);
});

test('POST /upload with an unchanged hash returns the stored profile directly (jobId null)', async () => {
  await grantConsent();
  const pdf = makePdf(LONG);
  const hash = crypto.createHash('sha256').update(pdf).digest('hex');
  await (await col('users')).updateOne(
    { _id: USER },
    { $set: { lastResumeHash: hash, parsedProfile: { fullName: 'Cached' } } },
  );
  const res = await request(buildApp()).post('/api/seeker/resume/upload').set('Cookie', cookie())
    .attach('resume', pdf, { filename: 'r.pdf', contentType: 'application/pdf' });
  assert.equal(res.status, 200);
  assert.equal(res.body.isUnchanged, true);
  assert.equal(res.body.jobId, null);
  assert.equal(res.body.profile.fullName, 'Cached');
});

test('POST /upload non-PDF → 400 INVALID_FILE_TYPE', async () => {
  await grantConsent();
  const res = await request(buildApp()).post('/api/seeker/resume/upload').set('Cookie', cookie())
    .attach('resume', Buffer.from('hello'), { filename: 'r.txt', contentType: 'text/plain' });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'INVALID_FILE_TYPE');
});

test('POST /upload too large → 400 FILE_TOO_LARGE', async () => {
  await grantConsent();
  const big = Buffer.alloc(6 * 1024 * 1024, 1);
  const res = await request(buildApp()).post('/api/seeker/resume/upload').set('Cookie', cookie())
    .attach('resume', big, { filename: 'r.pdf', contentType: 'application/pdf' });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'FILE_TOO_LARGE');
});

test('POST /upload no file → 400 NO_FILE', async () => {
  await grantConsent();
  const res = await request(buildApp()).post('/api/seeker/resume/upload').set('Cookie', cookie());
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'NO_FILE');
});

test('POST /text with valid text → 200 { jobId, status: queued }', async () => {
  await grantConsent();
  const res = await request(buildApp()).post('/api/seeker/resume/text').set('Cookie', cookie()).send({ text: LONG.repeat(2) });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'queued');
  assert.ok(res.body.jobId);
});

test('GET /jobs/:jobId returns the caller\'s job status', async () => {
  await grantConsent();
  const created = await request(buildApp()).post('/api/seeker/resume/text').set('Cookie', cookie()).send({ text: LONG.repeat(2) });
  const res = await request(buildApp()).get(`/api/seeker/resume/jobs/${created.body.jobId}`).set('Cookie', cookie());
  assert.equal(res.status, 200);
  assert.equal(res.body.job.id, created.body.jobId);
  assert.equal(res.body.job.status, 'queued');
});

test('GET /jobs/:jobId for another user\'s job → 404 JOB_NOT_FOUND', async () => {
  await grantConsent();
  const foreign = await insertResumeParseJob({ userId: OTHER.toString(), source: 'text', resumeText: 't', fileHash: 'h1' });
  const res = await request(buildApp()).get(`/api/seeker/resume/jobs/${foreign._id.toString()}`).set('Cookie', cookie());
  assert.equal(res.status, 404);
  assert.equal(res.body.code, 'JOB_NOT_FOUND');
});

test('POST /text with short text → 400', async () => {
  await grantConsent();
  const res = await request(buildApp()).post('/api/seeker/resume/text').set('Cookie', cookie()).send({ text: 'too short' });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'INVALID_RESUME_TEXT');
});

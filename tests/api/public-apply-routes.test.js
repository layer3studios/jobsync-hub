import './../_helpers/test-db.js';
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { ObjectId } from 'mongodb';

import { dropCollections, closeTestDb } from '../_helpers/test-db.js';
import { col } from '../../src/Db/connection.js';
import { errorHandler } from '../../src/middleware/error-handler-middleware.js';
import publicApplyRouter from '../../src/api/public/public-apply-routes.js';
import { ensureContactIndexes } from '../../src/models/public/contact-model.js';

const COMPANY_ID = new ObjectId();
const JOB_ID = new ObjectId();

function buildApp() {
  const app = express();
  app.use('/api/public', publicApplyRouter);
  app.use(errorHandler);
  return app;
}
const PDF = Buffer.from('%PDF-1.4 test');

function applyReq(app, { honeypot = false, consent = true, withResume = true } = {}) {
  let req = request(app).post('/api/public/jobs/acme/react-dev/apply')
    .field('firstName', 'Asha').field('lastName', 'Rao').field('email', 'asha@x.com');
  if (consent) req = req.field('consent_dpdp', 'true');
  if (honeypot) req = req.field('website_url', 'http://spam.example');
  if (withResume) req = req.attach('resume', PDF, { filename: 'cv.pdf', contentType: 'application/pdf' });
  return req;
}

before(async () => { await reset(); });
beforeEach(async () => { await reset(); });
after(async () => { await closeTestDb(); });
async function reset() {
  await dropCollections('companies', 'jobs', 'stages', 'contacts', 'applications', 'stage_changes', 'resume_files');
  await ensureContactIndexes();
  await (await col('companies')).insertOne({ _id: COMPANY_ID, slug: 'acme', name: 'Acme', website: null, logoUrl: null });
  await (await col('jobs')).insertOne({
    _id: JOB_ID, companyId: COMPANY_ID, slug: 'react-dev', source: 'native', status: 'active',
    title: 'React Dev', description: 'd', descriptionPlain: 'd', location: 'Bengaluru',
    workplaceType: 'remote', employmentType: 'full-time', salaryCurrency: 'INR', createdAt: new Date(), updatedAt: new Date(),
  });
  await (await col('stages')).insertOne({ _id: new ObjectId(), companyId: COMPANY_ID, isDefault: true, text: 'Applied', order: 1 });
}

test('GET /companies/:slug returns company + active jobs', async () => {
  const res = await request(buildApp()).get('/api/public/companies/acme');
  assert.equal(res.status, 200);
  assert.equal(res.body.company.name, 'Acme');
  assert.equal(res.body.jobs.length, 1);
  assert.equal(res.body.jobs[0].slug, 'react-dev');
});

test('GET /companies/:slug for an unknown company → 404', async () => {
  const res = await request(buildApp()).get('/api/public/companies/nope');
  assert.equal(res.status, 404);
  assert.equal(res.body.code, 'COMPANY_NOT_FOUND');
});

test('GET /jobs/:companySlug/:jobSlug returns the job detail', async () => {
  const res = await request(buildApp()).get('/api/public/jobs/acme/react-dev');
  assert.equal(res.status, 200);
  assert.equal(res.body.job.title, 'React Dev');
});

test('GET /jobs for a closed posting → 404', async () => {
  await (await col('jobs')).updateOne({ _id: JOB_ID }, { $set: { status: 'closed' } });
  const res = await request(buildApp()).get('/api/public/jobs/acme/react-dev');
  assert.equal(res.status, 404);
  assert.equal(res.body.code, 'POSTING_NOT_FOUND');
});

test('POST apply happy path → 200 { applicationId }', async () => {
  const res = await applyReq(buildApp());
  assert.equal(res.status, 200);
  assert.ok(res.body.applicationId && res.body.applicationId !== 'ok');
  assert.equal(await (await col('applications')).countDocuments({}), 1);
});

test('POST apply without a resume → 400 NO_FILE', async () => {
  const res = await applyReq(buildApp(), { withResume: false });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'NO_FILE');
});

test('POST apply without consent → 400 CONSENT_REQUIRED', async () => {
  const res = await applyReq(buildApp(), { consent: false });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'CONSENT_REQUIRED');
});

test('POST apply with the honeypot filled → 200 silently, no records', async () => {
  const res = await applyReq(buildApp(), { honeypot: true });
  assert.equal(res.status, 200);
  assert.equal(res.body.applicationId, 'ok');
  assert.equal(await (await col('applications')).countDocuments({}), 0);
});

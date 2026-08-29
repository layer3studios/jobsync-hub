// FILE: tests/api/admin-job-browser.test.js
// /api/admin/jobs: search, the native-delete refusal, hide, and the auth gate.
// The service runs against the real (test) database so the refusal and the
// hide field are proven against real documents, not stubs.
import '../_helpers/test-db.js'; // MUST be first: sets env before env.js loads
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { ObjectId } from 'mongodb';

import { dropCollections, closeTestDb } from '../_helpers/test-db.js';
import { col } from '../../src/Db/connection.js';
import { JWT_SECRET } from '../../src/env.js';
import { errorHandler } from '../../src/middleware/error-handler-middleware.js';
import { requireAdmin } from '../../src/middleware/require-admin-middleware.js';
import { createJobBrowserRouter } from '../../src/api/admin/job-browser-routes.js';
import { deleteScrapedJob } from '../../src/services/admin/job-browser-service.js';
import { findJobById, getPublicBaitJobs } from '../../src/Db/jobs/queries.js';

const SCRAPED_ID = new ObjectId();
const NATIVE_ID = new ObjectId();

async function seedJobs() {
  await dropCollections('jobs', 'audit_log');
  await (await col('jobs')).insertMany([
    {
      _id: SCRAPED_ID, JobID: 'gh-1', sourceSite: 'Greenhouse Jobs',
      JobTitle: 'Senior Platform Engineer', Company: 'Acme',
      Location: 'Bengaluru', Status: 'active', PostedDate: new Date('2026-08-20'),
      Description: '<p>raw html</p>', DescriptionCleaned: 'cleaned copy',
    },
    {
      _id: NATIVE_ID, source: 'native', companyId: new ObjectId(),
      title: 'Native Product Designer', status: 'active',
      slug: 'native-product-designer', createdAt: new Date('2026-08-25'),
    },
  ]);
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  // REAL service — the delete guard is what this file exists to prove.
  app.use('/api/admin/jobs', requireAdmin, createJobBrowserRouter());
  app.use(errorHandler);
  return app;
}

/** requireAdmin re-checks isActive on every call, so a real admin row is needed. */
let cachedCookie = null;
async function adminCookie() {
  if (cachedCookie) return cachedCookie;
  const admins = await col('admin_users');
  const email = 'job-browser-admin@jobmesh.in';
  await admins.updateOne(
    { email },
    { $set: { email, name: 'Admin', isActive: true, createdAt: new Date() } },
    { upsert: true },
  );
  const admin = await admins.findOne({ email });
  cachedCookie = `jm_admin_token=${jwt.sign({ adminUserId: admin._id.toString() }, JWT_SECRET)}`;
  return cachedCookie;
}

beforeEach(seedJobs);

after(async () => {
  await dropCollections('jobs', 'audit_log');
  await (await col('admin_users')).deleteOne({ email: 'job-browser-admin@jobmesh.in' });
  await closeTestDb();
});

test('every route rejects a request with no admin cookie', async () => {
  const app = buildApp();
  assert.equal((await request(app).get('/api/admin/jobs')).status, 401);
  assert.equal((await request(app).get(`/api/admin/jobs/${SCRAPED_ID}`)).status, 401);
  assert.equal((await request(app).post(`/api/admin/jobs/${SCRAPED_ID}/hide`)).status, 401);
  assert.equal((await request(app).delete(`/api/admin/jobs/${SCRAPED_ID}`)).status, 401);
});

test('GET / searches both schemas and labels each row by source', async () => {
  const res = await request(buildApp()).get('/api/admin/jobs').set('Cookie', await adminCookie());
  assert.equal(res.status, 200);
  assert.equal(res.body.data.total, 2);

  const scraped = res.body.data.jobs.find((job) => job.id === SCRAPED_ID.toString());
  assert.equal(scraped.title, 'Senior Platform Engineer');
  assert.equal(scraped.isNative, false);
  assert.equal(scraped.siteName, 'Greenhouse Jobs');

  // A native posting has no JobTitle — its camelCase `title` must still show.
  const native = res.body.data.jobs.find((job) => job.id === NATIVE_ID.toString());
  assert.equal(native.title, 'Native Product Designer');
  assert.equal(native.isNative, true);
});

test('the q filter matches a native posting title as well as a scraped one', async () => {
  const cookie = await adminCookie();
  const app = buildApp();
  const scraped = await request(app).get('/api/admin/jobs?q=Platform').set('Cookie', cookie);
  assert.deepEqual(scraped.body.data.jobs.map((job) => job.id), [SCRAPED_ID.toString()]);

  const native = await request(app).get('/api/admin/jobs?q=Designer').set('Cookie', cookie);
  assert.deepEqual(native.body.data.jobs.map((job) => job.id), [NATIVE_ID.toString()]);
});

test('DELETE refuses a native posting with 403 and leaves it in place', async () => {
  const res = await request(buildApp())
    .delete(`/api/admin/jobs/${NATIVE_ID}`)
    .set('Cookie', await adminCookie());

  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'native_posting');
  assert.equal(res.body.data.deleted, false);
  // The posting must still exist — the employer owns it.
  assert.ok(await (await col('jobs')).findOne({ _id: NATIVE_ID }));
  // And nothing was audited as deleted.
  assert.equal(await (await col('audit_log')).countDocuments({ event: 'job_deleted' }), 0);
});

test('the native-delete guard holds at the SERVICE layer too, not just the route', async () => {
  const result = await deleteScrapedJob(NATIVE_ID.toString(), null);
  assert.deepEqual(result, { deleted: false, reason: 'native_posting' });
  assert.ok(await (await col('jobs')).findOne({ _id: NATIVE_ID }));
});

test('DELETE removes a scraped job and audits it first', async () => {
  const res = await request(buildApp())
    .delete(`/api/admin/jobs/${SCRAPED_ID}`)
    .set('Cookie', await adminCookie());

  assert.equal(res.status, 200);
  assert.equal(res.body.data.deleted, true);
  assert.equal(await (await col('jobs')).findOne({ _id: SCRAPED_ID }), null);

  // The audit row is the only surviving record of the job.
  const entry = await (await col('audit_log')).findOne({ event: 'job_deleted' });
  assert.equal(entry.metadata.title, 'Senior Platform Engineer');
  assert.equal(entry.metadata.siteName, 'Greenhouse Jobs');
  assert.equal(entry.metadata.source, 'scraped');
});

test('hide sets adminHiddenAt, and seeker reads then skip the job', async () => {
  const cookie = await adminCookie();
  const app = buildApp();

  // Visible to seekers before hiding.
  assert.ok(await findJobById(SCRAPED_ID.toString()));
  assert.equal((await getPublicBaitJobs()).length, 1);

  const res = await request(app).post(`/api/admin/jobs/${SCRAPED_ID}/hide`).set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.equal(res.body.data.job.isHidden, true);

  const doc = await (await col('jobs')).findOne({ _id: SCRAPED_ID });
  assert.ok(doc.adminHiddenAt instanceof Date);
  assert.equal(doc.Status, 'active', 'hiding must not touch Status');

  // The whole point: seeker-facing reads no longer return it.
  assert.equal(await findJobById(SCRAPED_ID.toString()), null);
  assert.equal((await getPublicBaitJobs()).length, 0);
  assert.equal(await (await col('audit_log')).countDocuments({ event: 'job_hidden' }), 1);

  // Unhide restores it.
  await request(app).post(`/api/admin/jobs/${SCRAPED_ID}/unhide`).set('Cookie', cookie);
  assert.ok(await findJobById(SCRAPED_ID.toString()));
  assert.equal(await (await col('audit_log')).countDocuments({ event: 'job_unhidden' }), 1);
});

test('the hidden filter selects exactly the hidden rows', async () => {
  const cookie = await adminCookie();
  const app = buildApp();
  await request(app).post(`/api/admin/jobs/${SCRAPED_ID}/hide`).set('Cookie', cookie);

  const excluded = await request(app).get('/api/admin/jobs?hidden=exclude').set('Cookie', cookie);
  assert.deepEqual(excluded.body.data.jobs.map((job) => job.id), [NATIVE_ID.toString()]);

  const only = await request(app).get('/api/admin/jobs?hidden=only').set('Cookie', cookie);
  assert.deepEqual(only.body.data.jobs.map((job) => job.id), [SCRAPED_ID.toString()]);

  const all = await request(app).get('/api/admin/jobs?hidden=all').set('Cookie', cookie);
  assert.equal(all.body.data.total, 2);
});

test('GET /:id returns the cleaned description, not the raw ATS html', async () => {
  const res = await request(buildApp())
    .get(`/api/admin/jobs/${SCRAPED_ID}`)
    .set('Cookie', await adminCookie());
  assert.equal(res.status, 200);
  assert.equal(res.body.data.job.description, 'cleaned copy');
  assert.equal(res.body.data.job.descriptionIsCleaned, true);
  assert.ok(!('Description' in res.body.data.job), 'the raw html is not shipped');
});

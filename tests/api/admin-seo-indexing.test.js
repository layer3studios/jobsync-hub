// FILE: tests/api/admin-seo-indexing.test.js
// The indexing queue (dedupe, native-only, worker outcomes incl. 429 backoff),
// stale-URL detection, and the SEO routes. The Google client is ALWAYS stubbed —
// no test in this file may reach the real Indexing API.
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
import { createSeoRouter } from '../../src/api/admin/seo-routes.js';
import {
  ensureIndexingJobIndexes, enqueueIndexingJob, INDEXING_ACTIONS, INDEXING_STATUS,
} from '../../src/models/admin/indexing-job-model.js';
import { processNextIndexingJob } from '../../src/services/admin/indexing-worker.js';
import {
  enqueuePostingIndexing, buildPostingUrl, isNativePosting,
} from '../../src/services/admin/posting-indexing-hook.js';
import { getStaleUrls, getSchemaHealth } from '../../src/services/admin/seo-health-service.js';

const POSTING_ID = new ObjectId();
const COMPANY_ID = new ObjectId();

const nativePosting = (over = {}) => ({
  _id: POSTING_ID, source: 'native', companyId: COMPANY_ID,
  slug: 'senior-engineer', title: 'Senior Engineer', status: 'active', ...over,
});

async function seedCompany() {
  await (await col('companies')).updateOne(
    { _id: COMPANY_ID },
    { $set: { _id: COMPANY_ID, name: 'Acme', slug: 'acme' } },
    { upsert: true },
  );
}

beforeEach(async () => {
  await dropCollections('indexing_jobs', 'jobs', 'companies');
  await ensureIndexingJobIndexes();
  await seedCompany();
});

after(async () => {
  await dropCollections('indexing_jobs', 'jobs', 'companies');
  await (await col('admin_users')).deleteOne({ email: 'seo-admin@jobmesh.in' });
  await closeTestDb();
});

// ─── URL construction + native-only ─────────────────────────────────

test('the public URL is the absolute apply page path', () => {
  const url = buildPostingUrl('acme', 'senior-engineer');
  assert.match(url, /\/apply\/acme\/senior-engineer$/);
  assert.ok(url.startsWith('http'), 'must be absolute');
  // A missing slug yields no URL rather than a guessed path.
  assert.equal(buildPostingUrl('acme', null), null);
  assert.equal(buildPostingUrl(null, 'senior-engineer'), null);
});

test('a scraped job is never enqueued, whatever the caller asks for', async () => {
  assert.equal(isNativePosting({ sourceSite: 'Greenhouse Jobs', slug: 'x' }), false);
  const scraped = { _id: new ObjectId(), sourceSite: 'Greenhouse Jobs', JobID: 'gh-1', slug: 'x' };
  const result = await enqueuePostingIndexing(scraped, 'updated');
  assert.deepEqual(result, { enqueued: false, reason: 'not_native' });
  assert.equal(await (await col('indexing_jobs')).countDocuments({}), 0);
});

test('enqueuePostingIndexing never throws when its dependencies fail', async () => {
  const result = await enqueuePostingIndexing(nativePosting(), 'updated', {
    getCompanySlug: async () => { throw new Error('mongo is down'); },
  });
  assert.deepEqual(result, { enqueued: false, reason: 'error' });
});

test('a posting whose company slug cannot be resolved is skipped, not guessed', async () => {
  const result = await enqueuePostingIndexing(nativePosting(), 'updated', {
    getCompanySlug: async () => null,
  });
  assert.deepEqual(result, { enqueued: false, reason: 'no_url' });
});

// ─── Dedupe ─────────────────────────────────────────────────────────

test('a double publish collapses into ONE queued job', async () => {
  await enqueuePostingIndexing(nativePosting(), 'updated');
  await enqueuePostingIndexing(nativePosting(), 'updated');
  const jobs = await (await col('indexing_jobs')).find({}).toArray();
  assert.equal(jobs.length, 1, 'one URL must not spend two of the 200 daily calls');
  assert.equal(jobs[0].action, INDEXING_ACTIONS.UPDATED);
  assert.match(jobs[0].url, /\/apply\/acme\/senior-engineer$/);
});

test('a slug edit before the worker runs updates the queued URL in place', async () => {
  await enqueuePostingIndexing(nativePosting(), 'updated');
  await enqueuePostingIndexing(nativePosting({ slug: 'staff-engineer' }), 'updated');
  const jobs = await (await col('indexing_jobs')).find({}).toArray();
  assert.equal(jobs.length, 1);
  assert.match(jobs[0].url, /staff-engineer$/, 'the new slug wins');
});

test('update and delete are distinct jobs, not one', async () => {
  await enqueuePostingIndexing(nativePosting(), 'updated');
  await enqueuePostingIndexing(nativePosting({ status: 'closed' }), 'deleted');
  assert.equal(await (await col('indexing_jobs')).countDocuments({}), 2);
});

// ─── Worker ─────────────────────────────────────────────────────────

const okClient = () => ({ publishUrl: async () => ({ ok: true, status: 200 }) });
const quotaClient = () => ({ publishUrl: async () => ({ ok: false, status: 429, error: 'quota' }) });
const errorClient = () => ({ publishUrl: async () => ({ ok: false, status: 500, error: 'boom' }) });

test('a successful submission marks the job done', async () => {
  await enqueuePostingIndexing(nativePosting(), 'updated');
  const { outcome } = await processNextIndexingJob(okClient());
  assert.equal(outcome, 'done');
  const job = await (await col('indexing_jobs')).findOne({});
  assert.equal(job.status, INDEXING_STATUS.DONE);
  assert.ok(job.completedAtExpiry instanceof Date, 'TTL clock is set');
});

test('an idle queue reports idle rather than erroring', async () => {
  const { outcome, job } = await processNextIndexingJob(okClient());
  assert.equal(outcome, 'idle');
  assert.equal(job, null);
});

test('a 429 releases the job WITHOUT spending an attempt', async () => {
  await enqueuePostingIndexing(nativePosting(), 'updated');
  const { outcome } = await processNextIndexingJob(quotaClient());
  assert.equal(outcome, 'quota');

  const job = await (await col('indexing_jobs')).findOne({});
  assert.equal(job.status, INDEXING_STATUS.QUEUED, 'the job goes back in the queue');
  // The claim incremented to 1; the release must undo it. Quota is our problem,
  // not this job's, so it must not burn through MAX_ATTEMPTS during an outage.
  assert.equal(job.attemptCount, 0);
});

test('a real error retries twice then fails terminally', async () => {
  await enqueuePostingIndexing(nativePosting(), 'updated');
  assert.equal((await processNextIndexingJob(errorClient())).outcome, 'retry');
  assert.equal((await processNextIndexingJob(errorClient())).outcome, 'retry');
  assert.equal((await processNextIndexingJob(errorClient())).outcome, 'failed');

  const job = await (await col('indexing_jobs')).findOne({});
  assert.equal(job.status, INDEXING_STATUS.FAILED);
  assert.equal(job.attemptCount, 3);
  assert.match(job.lastError, /boom/);
});

test('a throwing client is handled like any other failure', async () => {
  await enqueueIndexingJob({ postingId: POSTING_ID, url: 'https://x.test/a', action: INDEXING_ACTIONS.UPDATED });
  const { outcome } = await processNextIndexingJob({
    publishUrl: async () => { throw new Error('socket hang up'); },
  });
  assert.equal(outcome, 'retry');
});

// ─── Schema health + stale URLs ─────────────────────────────────────

test('schema health counts what the JSON-LD would have to fall back on', async () => {
  await (await col('jobs')).insertMany([
    { source: 'native', status: 'active', title: 'Full', location: 'Bengaluru', employmentType: 'FULL_TIME', salaryMin: 100, salaryMax: 200 },
    { source: 'native', status: 'active', title: 'No salary', location: 'Pune', employmentType: 'FULL_TIME', salaryMin: null, salaryMax: null },
    { source: 'native', status: 'active', title: 'Bare' },
    { source: 'native', status: 'closed', title: 'Closed — not counted' },
    { sourceSite: 'Greenhouse Jobs', JobTitle: 'Scraped — not counted', Status: 'active' },
  ]);

  const health = await getSchemaHealth();
  assert.equal(health.total, 3, 'live NATIVE postings only');
  assert.equal(health.missingSalary, 2);
  assert.equal(health.missingLocation, 1);
  assert.equal(health.missingEmploymentType, 1);
});

test('a closed posting with no completed removal shows as a stale URL', async () => {
  const closedId = new ObjectId();
  await (await col('jobs')).insertOne({
    _id: closedId, source: 'native', companyId: COMPANY_ID, slug: 'gone',
    title: 'Closed Role', status: 'closed', closedAt: new Date(),
  });

  const before = await getStaleUrls();
  assert.deepEqual(before.map((row) => row.postingId), [closedId.toString()]);

  // Once a removal has actually completed, it drops off the list.
  await (await col('indexing_jobs')).insertOne({
    postingId: closedId, url: 'https://x.test/apply/acme/gone',
    action: INDEXING_ACTIONS.DELETED, status: INDEXING_STATUS.DONE, completedAt: new Date(),
  });
  assert.deepEqual(await getStaleUrls(), []);
});

test('a merely QUEUED removal does not clear a stale URL', async () => {
  const closedId = new ObjectId();
  await (await col('jobs')).insertOne({
    _id: closedId, source: 'native', companyId: COMPANY_ID, slug: 'gone',
    title: 'Closed Role', status: 'closed', closedAt: new Date(),
  });
  await (await col('indexing_jobs')).insertOne({
    postingId: closedId, url: 'https://x.test/apply/acme/gone',
    action: INDEXING_ACTIONS.DELETED, status: INDEXING_STATUS.QUEUED,
  });
  // Google has not been told until the submission succeeds.
  assert.equal((await getStaleUrls()).length, 1);
});

// ─── Routes ─────────────────────────────────────────────────────────

function buildApp(overrides = {}) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/admin/seo', requireAdmin, createSeoRouter({
    // The client is stubbed to null unless a test says otherwise: no route in
    // this file may construct a real Google client.
    buildIndexingClient: () => null,
    ...overrides,
  }));
  app.use(errorHandler);
  return app;
}

let cachedCookie = null;
async function adminCookie() {
  if (cachedCookie) return cachedCookie;
  const admins = await col('admin_users');
  const email = 'seo-admin@jobmesh.in';
  await admins.updateOne(
    { email },
    { $set: { email, name: 'Admin', isActive: true, createdAt: new Date() } },
    { upsert: true },
  );
  const admin = await admins.findOne({ email });
  cachedCookie = `jm_admin_token=${jwt.sign({ adminUserId: admin._id.toString() }, JWT_SECRET)}`;
  return cachedCookie;
}

test('every SEO route rejects a request with no admin cookie', async () => {
  const app = buildApp();
  assert.equal((await request(app).get('/api/admin/seo')).status, 401);
  assert.equal((await request(app).post('/api/admin/seo/retry/abc')).status, 401);
  assert.equal((await request(app).post(`/api/admin/seo/submit/${POSTING_ID}`)).status, 401);
});

test('GET / reports configured:false when no service account is set', async () => {
  const res = await request(buildApp()).get('/api/admin/seo').set('Cookie', await adminCookie());
  assert.equal(res.status, 200);
  assert.equal(res.body.data.configured, false);
  assert.equal(res.body.data.indexing.dailyQuota, 200);
  assert.ok('schema' in res.body.data && 'staleUrls' in res.body.data);
});

test('GET / reports configured:true when a client can be built', async () => {
  const res = await request(buildApp({ buildIndexingClient: () => ({ publishUrl: async () => ({ ok: true }) }) }))
    .get('/api/admin/seo').set('Cookie', await adminCookie());
  assert.equal(res.body.data.configured, true);
});

test('POST submit refuses a closed posting for indexing and a live one for removal', async () => {
  const cookie = await adminCookie();
  const live = nativePosting();
  const closed = nativePosting({ status: 'closed' });

  const liveAsDeleted = await request(buildApp({ findLiveNativePosting: async () => live }))
    .post(`/api/admin/seo/submit/${POSTING_ID}?action=deleted`).set('Cookie', cookie);
  assert.equal(liveAsDeleted.status, 400);
  assert.equal(liveAsDeleted.body.code, 'POSTING_STILL_LIVE');

  const closedAsUpdate = await request(buildApp({ findLiveNativePosting: async () => closed }))
    .post(`/api/admin/seo/submit/${POSTING_ID}`).set('Cookie', cookie);
  assert.equal(closedAsUpdate.status, 400);
  assert.equal(closedAsUpdate.body.code, 'POSTING_NOT_LIVE');
});

test('POST submit queues a removal for a closed posting', async () => {
  const res = await request(buildApp({ findLiveNativePosting: async () => nativePosting({ status: 'closed' }) }))
    .post(`/api/admin/seo/submit/${POSTING_ID}?action=deleted`).set('Cookie', await adminCookie());
  assert.equal(res.status, 200);
  assert.equal(res.body.data.action, 'deleted');
  const job = await (await col('indexing_jobs')).findOne({ action: INDEXING_ACTIONS.DELETED });
  assert.ok(job, 'the removal is queued, not sent inline');
});

test('POST retry requeues only a failed job', async () => {
  const cookie = await adminCookie();
  const jobs = await col('indexing_jobs');
  const { insertedId } = await jobs.insertOne({
    postingId: POSTING_ID, url: 'https://x.test/a', action: INDEXING_ACTIONS.UPDATED,
    status: INDEXING_STATUS.FAILED, attemptCount: 3, lastError: 'boom', completedAt: new Date(),
  });

  const res = await request(buildApp()).post(`/api/admin/seo/retry/${insertedId}`).set('Cookie', cookie);
  assert.equal(res.status, 200);
  const job = await jobs.findOne({ _id: insertedId });
  assert.equal(job.status, INDEXING_STATUS.QUEUED);
  assert.equal(job.attemptCount, 0, 'attempts reset so the retry gets a full budget');

  // A second retry finds nothing failed to requeue.
  const again = await request(buildApp()).post(`/api/admin/seo/retry/${insertedId}`).set('Cookie', cookie);
  assert.equal(again.status, 404);
});

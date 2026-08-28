// FILE: tests/api/admin-queue-monitor.test.js
// /api/admin/queues: one happy path per route plus the auth gate. The service is
// injected, so no worker collections and no live workers are needed.
import '../_helpers/test-db.js'; // MUST be first: sets env before env.js loads
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import jwt from 'jsonwebtoken';

import { closeTestDb } from '../_helpers/test-db.js';
import { col } from '../../src/Db/connection.js';
import { JWT_SECRET } from '../../src/env.js';
import { errorHandler } from '../../src/middleware/error-handler-middleware.js';
import { requireAdmin } from '../../src/middleware/require-admin-middleware.js';
import { createQueueMonitorRouter } from '../../src/api/admin/queue-monitor-routes.js';

const QUEUES = [{
  key: 'resume-parse',
  label: 'Resume parsing',
  counts: { queued: 2, processing: 1, done: 40, failed: 3 },
  oldestPendingAgeMs: 725_000,
  failedCount: 3,
  lastCompletedAt: '2026-08-29T10:00:00.000Z',
}];

const FAILED_JOBS = [{
  id: '6a920a6631e857a1f67f3856',
  identityLabel: 'userId',
  identityValue: '6a920a6631e857a1f67f3850',
  errorMessage: 'PDF_UNREADABLE',
  attemptCount: null,
  createdAt: '2026-08-29T09:00:00.000Z',
  failedAt: '2026-08-29T09:00:12.000Z',
}];

let lastFailedArgs = null;
let lastRetryArgs = null;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/admin/queues', requireAdmin, createQueueMonitorRouter({
    getQueueOverview: async () => QUEUES,
    listFailedJobs: async (...args) => { lastFailedArgs = args; return FAILED_JOBS; },
    retryFailedJob: async (...args) => { lastRetryArgs = args; return { retried: true }; },
    isKnownQueue: (key) => key === 'resume-parse',
  }));
  app.use(errorHandler);
  return app;
}

/** requireAdmin re-checks isActive on every call, so a real admin row is needed. */
let cachedCookie = null;
async function adminCookie() {
  if (cachedCookie) return cachedCookie;
  const admins = await col('admin_users');
  const email = 'queue-monitor-admin@jobmesh.in';
  await admins.updateOne(
    { email },
    { $set: { email, name: 'Admin', isActive: true, createdAt: new Date() } },
    { upsert: true },
  );
  const admin = await admins.findOne({ email });
  cachedCookie = `jm_admin_token=${jwt.sign({ adminUserId: admin._id.toString() }, JWT_SECRET)}`;
  return cachedCookie;
}

after(async () => {
  await (await col('admin_users')).deleteOne({ email: 'queue-monitor-admin@jobmesh.in' });
  await closeTestDb();
});

test('every route rejects a request with no admin cookie', async () => {
  const app = buildApp();
  assert.equal((await request(app).get('/api/admin/queues')).status, 401);
  assert.equal((await request(app).get('/api/admin/queues/resume-parse/failed')).status, 401);
  assert.equal((await request(app).post('/api/admin/queues/resume-parse/failed/abc/retry')).status, 401);
});

test('GET / returns the queue cards', async () => {
  const res = await request(buildApp()).get('/api/admin/queues').set('Cookie', await adminCookie());
  assert.equal(res.status, 200);
  assert.equal(res.body.data.queues.length, 1);
  assert.equal(res.body.data.queues[0].key, 'resume-parse');
  assert.equal(res.body.data.queues[0].failedCount, 3);
  assert.equal(res.body.data.queues[0].counts.queued, 2);
});

test('GET /:queueKey/failed returns the narrow failed-job rows', async () => {
  const res = await request(buildApp())
    .get('/api/admin/queues/resume-parse/failed')
    .set('Cookie', await adminCookie());
  assert.equal(res.status, 200);
  assert.deepEqual(lastFailedArgs, ['resume-parse', 25]);
  const [job] = res.body.data.jobs;
  assert.equal(job.errorMessage, 'PDF_UNREADABLE');
  assert.equal(job.identityLabel, 'userId');
  // The projection must never carry resume content.
  assert.ok(!('resumeText' in job) && !('tmpPath' in job) && !('result' in job));
});

test('an unknown queueKey is a 400, not a 500 or an empty list', async () => {
  const cookie = await adminCookie();
  const app = buildApp();
  const listed = await request(app).get('/api/admin/queues/nope/failed').set('Cookie', cookie);
  assert.equal(listed.status, 400);
  assert.equal(listed.body.code, 'unknown_queue');

  const retried = await request(app).post('/api/admin/queues/nope/failed/abc/retry').set('Cookie', cookie);
  assert.equal(retried.status, 400);
});

test('POST retry passes the queue and job through and reports the outcome', async () => {
  const res = await request(buildApp())
    .post('/api/admin/queues/resume-parse/failed/6a920a6631e857a1f67f3856/retry')
    .set('Cookie', await adminCookie());
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data, { retried: true });
  assert.deepEqual(lastRetryArgs, ['resume-parse', '6a920a6631e857a1f67f3856']);
});

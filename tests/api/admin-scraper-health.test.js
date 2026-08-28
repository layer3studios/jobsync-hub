// FILE: tests/api/admin-scraper-health.test.js
// /api/admin/scraper-health: auth gating, the overview + runs reads, and the
// run-now trigger including its already_running short-circuit. Every dep is
// injected, so no real scrape and no scrape_runs data are needed.
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
import { createScraperHealthRouter, parseLimit } from '../../src/api/admin/scraper-health-routes.js';

const SITES = [
  { siteName: 'ashby', latestNewJobs: 4, avgNewJobs: 40, isVolumeAnomalous: true, lastRunFailed: false, errorMessage: null },
  { siteName: 'lever', latestNewJobs: 0, avgNewJobs: 12, isVolumeAnomalous: false, lastRunFailed: true, errorMessage: 'HTTP 503' },
];
const CORPUS = {
  totalJobs: 1000, cleanedCount: 900, taggedCount: 800, salaryCount: 250,
  pctCleaned: 90, pctTagged: 80, pctSalary: 25, duplicateJobIds: 2,
};
const RUNS = [
  { runId: 'p2', siteName: 'ashby', newJobs: 4, jobsFetched: 40, durationMs: 900, scrapedSuccessfully: true },
  { runId: 'p1', siteName: 'lever', newJobs: 0, jobsFetched: 0, durationMs: 120, scrapedSuccessfully: false },
];

let lastListArgs = null;
let runScraperCalls = 0;

/** `running` is a getter so a test can flip the lock between requests. */
function buildApp({ running = () => false } = {}) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/admin/scraper-health', requireAdmin, createScraperHealthRouter({
    getSiteSummaries: async () => SITES,
    getCorpusQuality: async () => CORPUS,
    listRecentRuns: async (args) => {
      lastListArgs = args;
      return args?.siteName ? RUNS.filter((run) => run.siteName === args.siteName) : RUNS;
    },
    isScraperRunning: running,
    // Never resolves: a real scrape outlives the request, and the route must
    // not await it. If it did, this request would hang and the test would fail.
    runScraper: () => { runScraperCalls += 1; return new Promise(() => {}); },
  }));
  app.use(errorHandler);
  return app;
}

/** requireAdmin re-checks isActive on every call, so a real admin row is needed. */
let cachedCookie = null;
async function adminCookie() {
  if (cachedCookie) return cachedCookie;
  const admins = await col('admin_users');
  const email = 'scraper-health-admin@jobmesh.in';
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
  await (await col('admin_users')).deleteOne({ email: 'scraper-health-admin@jobmesh.in' });
  await closeTestDb();
});

test('every route rejects a request with no admin cookie', async () => {
  const app = buildApp();
  assert.equal((await request(app).get('/api/admin/scraper-health')).status, 401);
  assert.equal((await request(app).get('/api/admin/scraper-health/runs')).status, 401);
  assert.equal((await request(app).post('/api/admin/scraper-health/run-now')).status, 401);
});

test('an invalid admin token gets 401 and never fires a scrape', async () => {
  const before = runScraperCalls;
  const res = await request(buildApp())
    .post('/api/admin/scraper-health/run-now')
    .set('Cookie', 'jm_admin_token=not-a-real-token');
  assert.equal(res.status, 401);
  assert.equal(runScraperCalls, before);
});

test('GET / returns the site summaries and the corpus strip', async () => {
  const res = await request(buildApp()).get('/api/admin/scraper-health').set('Cookie', await adminCookie());
  assert.equal(res.status, 200);
  const { sites, corpus } = res.body.data;
  assert.equal(sites.length, 2);
  assert.equal(sites[0].isVolumeAnomalous, true);
  assert.equal(sites[1].errorMessage, 'HTTP 503');
  assert.equal(corpus.pctCleaned, 90);
  assert.equal(corpus.duplicateJobIds, 2);
});

test('GET /runs defaults to a 50-row limit and no site filter', async () => {
  const res = await request(buildApp()).get('/api/admin/scraper-health/runs').set('Cookie', await adminCookie());
  assert.equal(res.status, 200);
  assert.equal(res.body.data.runs.length, 2);
  assert.deepEqual(lastListArgs, { siteName: undefined, limit: 50 });
});

test('GET /runs passes the site filter and the limit through', async () => {
  const res = await request(buildApp())
    .get('/api/admin/scraper-health/runs?site=ashby&limit=5')
    .set('Cookie', await adminCookie());
  assert.deepEqual(lastListArgs, { siteName: 'ashby', limit: 5 });
  assert.deepEqual(res.body.data.runs.map((run) => run.siteName), ['ashby']);
});

test('POST /run-now starts a scrape without awaiting it', async () => {
  const before = runScraperCalls;
  const res = await request(buildApp()).post('/api/admin/scraper-health/run-now').set('Cookie', await adminCookie());
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data, { started: true });
  assert.equal(runScraperCalls, before + 1);
});

test('a second POST /run-now while the lock is held returns already_running', async () => {
  // The lock flips to held once the first call has gone through, exactly as the
  // real isScraping flag behaves.
  let held = false;
  const app = buildApp({ running: () => held });
  const cookie = await adminCookie();
  const before = runScraperCalls;

  const first = await request(app).post('/api/admin/scraper-health/run-now').set('Cookie', cookie);
  held = true;
  const second = await request(app).post('/api/admin/scraper-health/run-now').set('Cookie', cookie);

  assert.deepEqual(first.body.data, { started: true });
  assert.deepEqual(second.body.data, { started: false, reason: 'already_running' });
  assert.equal(runScraperCalls, before + 1, 'the second call must not fire a second scrape');
});

test('parseLimit caps at 200 and rejects nonsense', () => {
  assert.equal(parseLimit('5'), 5);
  assert.equal(parseLimit('9999'), 200);  // capped
  assert.equal(parseLimit('abc'), 50);    // default
  assert.equal(parseLimit(undefined), 50);
  assert.equal(parseLimit('-5'), 50);
});

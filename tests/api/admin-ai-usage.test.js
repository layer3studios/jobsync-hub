// FILE: tests/api/admin-ai-usage.test.js
// GET /api/admin/ai-usage: auth gating, aggregation shape, range handling, and
// the live-limits passthrough. Stats and the tracker snapshot are injected, so
// no real AI state is needed.
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
import { createAdminAiUsageRouter, parseRangeDays } from '../../src/api/admin/admin-ai-usage-routes.js';

const STATS = [
  {
    date: '2026-08-01', tier: 'employer', model: 'gemini-3.6-flash', apiKeyIndex: 0,
    requests: 100, tokensEstimated: 400_000, cacheHits: 10, errors: { rate_limited: 2, other: 1 },
  },
  {
    date: '2026-08-01', tier: 'seeker', model: 'gemma-4-31b', apiKeyIndex: 1,
    requests: 40, tokensEstimated: 80_000, cacheHits: 5, errors: { quota_exhausted: 1 },
  },
  {
    date: '2026-08-02', tier: 'scraper', model: 'gemma-4-31b', apiKeyIndex: 0,
    requests: 60, tokensEstimated: 120_000, cacheHits: 0, errors: {},
  },
];

const SNAPSHOT = {
  models: [{
    model: 'gemini-3.6-flash',
    keys: [
      { keyIndex: 0, rpm: { used: 2, limit: 4 }, rpd: { used: 15, limit: 17 }, tpm: { used: 8000, limit: 212500 }, exhausted: false },
      { keyIndex: 1, rpm: { used: 0, limit: 4 }, rpd: { used: 20, limit: 17 }, tpm: { used: 0, limit: 212500 }, exhausted: true },
    ],
  }],
};

let lastRequestedDays = null;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/admin/ai-usage', requireAdmin, createAdminAiUsageRouter({
    listUsageStats: async (days) => { lastRequestedDays = days; return STATS; },
    getAiUsageSnapshot: () => SNAPSHOT,
  }));
  app.use(errorHandler);
  return app;
}

/**
 * A real admin row is required: requireAdmin re-checks isActive on every call.
 * Upserted once and reused — admin_users has a unique email index.
 */
let cachedCookie = null;
async function adminCookie() {
  if (cachedCookie) return cachedCookie;
  const admins = await col('admin_users');
  const email = 'ai-usage-admin@jobmesh.in';
  await admins.updateOne(
    { email },
    { $set: { email, name: 'Admin', isActive: true, createdAt: new Date() } },
    { upsert: true },
  );
  const admin = await admins.findOne({ email });
  cachedCookie = `jm_admin_token=${jwt.sign({ adminUserId: admin._id.toString() }, JWT_SECRET)}`;
  return cachedCookie;
}

after(async () => { await closeTestDb(); });

test('non-admin (no cookie) gets 401', async () => {
  const res = await request(buildApp()).get('/api/admin/ai-usage');
  assert.equal(res.status, 401);
});

test('an invalid admin token gets 401', async () => {
  const res = await request(buildApp())
    .get('/api/admin/ai-usage')
    .set('Cookie', 'jm_admin_token=not-a-real-token');
  assert.equal(res.status, 401);
});

test('summary totals are correct across every row', async () => {
  const res = await request(buildApp()).get('/api/admin/ai-usage').set('Cookie', await adminCookie());
  assert.equal(res.status, 200);
  const { summary } = res.body.data;
  assert.equal(summary.totalRequests, 200);      // 100 + 40 + 60
  assert.equal(summary.totalTokens, 600_000);    // 400k + 80k + 120k
  assert.equal(summary.totalCacheHits, 15);      // 10 + 5
  assert.equal(summary.totalErrors, 4);          // 2 + 1 + 1
  assert.equal(summary.cacheHitRate, 7);         // 15 / (15 + 200) = 6.97 -> 7.0
  assert.equal(summary.errorRate, 2);            // 4 / 200
});

test('byTier splits employer / seeker / scraper', async () => {
  const res = await request(buildApp()).get('/api/admin/ai-usage').set('Cookie', await adminCookie());
  const { byTier } = res.body.data;
  assert.deepEqual(byTier.employer, { requests: 100, tokens: 400_000, errors: 3 });
  assert.deepEqual(byTier.seeker, { requests: 40, tokens: 80_000, errors: 1 });
  assert.deepEqual(byTier.scraper, { requests: 60, tokens: 120_000, errors: 0 });
});

test('byModel merges rows for the same model and computes avg tokens', async () => {
  const res = await request(buildApp()).get('/api/admin/ai-usage').set('Cookie', await adminCookie());
  const { byModel } = res.body.data;
  const gemma = byModel.find((row) => row.model === 'gemma-4-31b');
  assert.equal(gemma.requests, 100);          // 40 (seeker) + 60 (scraper)
  assert.equal(gemma.tokens, 200_000);
  assert.equal(gemma.avgTokensPerRequest, 2000);
  const gemini = byModel.find((row) => row.model === 'gemini-3.6-flash');
  assert.equal(gemini.cacheHits, 10);
  assert.equal(gemini.avgTokensPerRequest, 4000);
  assert.equal(byModel[0].model, 'gemini-3.6-flash'); // sorted by requests desc... tie-break
});

test('byDay is a daily breakdown, oldest first', async () => {
  const res = await request(buildApp()).get('/api/admin/ai-usage').set('Cookie', await adminCookie());
  const { byDay } = res.body.data;
  assert.deepEqual(byDay.map((row) => row.date), ['2026-08-01', '2026-08-02']);
  assert.equal(byDay[0].requests, 140); // both 08-01 rows
  assert.equal(byDay[1].requests, 60);
});

test('currentLimits passes the live tracker snapshot through', async () => {
  const res = await request(buildApp()).get('/api/admin/ai-usage').set('Cookie', await adminCookie());
  const { currentLimits } = res.body.data;
  assert.equal(currentLimits.models[0].model, 'gemini-3.6-flash');
  assert.equal(currentLimits.models[0].keys[0].tpm.used, 8000);
  assert.equal(currentLimits.models[0].keys[1].exhausted, true);
  assert.ok(!JSON.stringify(currentLimits).includes('AIza'), 'no key material');
});

test('range=30d asks the store for 30 days; default is 7', async () => {
  const app = buildApp();
  const cookie = await adminCookie();
  await request(app).get('/api/admin/ai-usage?range=30d').set('Cookie', cookie);
  assert.equal(lastRequestedDays, 30);
  await request(app).get('/api/admin/ai-usage').set('Cookie', cookie);
  assert.equal(lastRequestedDays, 7);
});

test('parseRangeDays caps at 90 and rejects nonsense', () => {
  assert.equal(parseRangeDays('30d'), 30);
  assert.equal(parseRangeDays('365d'), 90);   // capped
  assert.equal(parseRangeDays('abc'), 7);     // default
  assert.equal(parseRangeDays(undefined), 7);
  assert.equal(parseRangeDays('-5d'), 7);
});

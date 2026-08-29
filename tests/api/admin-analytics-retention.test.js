// FILE: tests/api/admin-analytics-retention.test.js
// GET /api/admin/analytics/retention: auth gating, the 503 when analytics is not
// configured, the shaper math, and the low-sample flag. The analytics service is
// injected, so no PostHog key and no network are needed.
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
import { createAdminAnalyticsRouter } from '../../src/api/admin/admin-analytics-routes.js';
import { cohortRows, pct, LOW_SAMPLE_THRESHOLD } from '../../src/services/admin/analytics-retention-queries.js';
import { QUERIES } from '../../src/services/admin/analytics-queries.js';

// PostHog returns positional rows; these mirror the real column order.
const RESULTS = {
  dau_mau: [[120, 400, 1000]],
  weekly_cohort_returns: [
    ['2026-07-20', 50, 20],   // healthy cohort
    ['2026-07-27', 8, 3],     // below the low-sample threshold
    ['2026-08-03', 0, 0],     // empty week — must not divide by zero
  ],
  retention_signups_by_week: [['2026-07-20', 30], ['2026-07-27', 5]],
};

let lastNames = null;

function buildApp({ service = fakeService() } = {}) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/admin/analytics', requireAdmin, createAdminAnalyticsRouter({ service }));
  app.use(errorHandler);
  return app;
}

function fakeService() {
  return {
    runMany: async (names) => {
      lastNames = names;
      return { results: RESULTS, cachedAt: '2026-08-29T10:00:00.000Z' };
    },
    runNamed: async () => ({ results: [], cachedAt: '2026-08-29T10:00:00.000Z' }),
    clearCache: () => {},
  };
}

/** requireAdmin re-checks isActive on every call, so a real admin row is needed. */
let cachedCookie = null;
async function adminCookie() {
  if (cachedCookie) return cachedCookie;
  const admins = await col('admin_users');
  const email = 'retention-admin@jobmesh.in';
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
  await (await col('admin_users')).deleteOne({ email: 'retention-admin@jobmesh.in' });
  await closeTestDb();
});

test('the retention route rejects a request with no admin cookie', async () => {
  assert.equal((await request(buildApp()).get('/api/admin/analytics/retention')).status, 401);
});

test('it 503s when analytics is not configured, like its siblings', async () => {
  const res = await request(buildApp({ service: null }))
    .get('/api/admin/analytics/retention')
    .set('Cookie', await adminCookie());
  assert.equal(res.status, 503);
  assert.equal(res.body.code, 'ANALYTICS_DISABLED');
});

test('it bundles the three retention queries into one call', async () => {
  await request(buildApp()).get('/api/admin/analytics/retention').set('Cookie', await adminCookie());
  assert.deepEqual(lastNames, ['dau_mau', 'weekly_cohort_returns', 'retention_signups_by_week']);
});

test('stickiness reads the row positionally and computes dau/mau to one decimal', async () => {
  const res = await request(buildApp()).get('/api/admin/analytics/retention').set('Cookie', await adminCookie());
  assert.equal(res.status, 200);
  const { stickiness } = res.body.result;
  assert.deepEqual(stickiness, { dau: 120, wau: 400, mau: 1000, dauMauPct: 12 });
  assert.equal(res.body.cachedAt, '2026-08-29T10:00:00.000Z');
});

test('the response declares the W1 approximation rather than implying exactness', async () => {
  const res = await request(buildApp()).get('/api/admin/analytics/retention').set('Cookie', await adminCookie());
  assert.equal(res.body.result.w1IsApproximate, true);
  assert.match(res.body.result.w1Method, /7\+ days after first seen/);
  assert.equal(res.body.result.lowSampleThreshold, LOW_SAMPLE_THRESHOLD);
  // The field name itself must not read as exact W1.
  assert.ok('approxW1Returns' in res.body.result.cohorts[0]);
  assert.ok(!('w1Returns' in res.body.result.cohorts[0]));
});

test('cohort rows carry percentages, signups and the low-sample flag', async () => {
  const res = await request(buildApp()).get('/api/admin/analytics/retention').set('Cookie', await adminCookie());
  const [healthy, small, empty] = res.body.result.cohorts;

  assert.deepEqual(healthy, {
    week: '2026-07-20', cohortSize: 50, approxW1Returns: 20, approxW1Pct: 40,
    signups: 30, isLowSample: false,
  });
  // Under the threshold the number still comes through — the UI dims it, the API
  // does not hide it.
  assert.equal(small.isLowSample, true);
  assert.equal(small.approxW1Pct, 37.5);
  assert.equal(small.signups, 5);
  // A week with no signup row falls back to 0 rather than undefined.
  assert.equal(empty.signups, 0);
  assert.equal(empty.approxW1Pct, 0, 'a zero cohort must not divide by zero');
});

test('pct guards a zero denominator and rounds to one decimal', () => {
  assert.equal(pct(0, 0), 0);
  assert.equal(pct(5, 0), 0);
  assert.equal(pct(1, 3), 33.3);
  assert.equal(pct(120, 1000), 12);
});

test('cohortRows tolerates missing rows entirely', () => {
  assert.deepEqual(cohortRows(undefined, undefined), []);
  assert.deepEqual(cohortRows([], []), []);
});

test('the retention queries are registered and use no JOIN', () => {
  for (const name of ['dau_mau', 'weekly_cohort_returns', 'retention_signups_by_week']) {
    const sql = QUERIES[name]('2026-08-01T00:00:00.000Z');
    assert.ok(typeof sql === 'string' && sql.startsWith('SELECT'), `${name} builds SQL`);
    assert.ok(!/\bJOIN\b/i.test(sql), `${name} must not JOIN`);
    assert.ok(/FROM events/.test(sql), `${name} reads the single events table`);
  }
  // Stickiness windows are fixed by definition, not driven by the range selector.
  const stickinessSql = QUERIES.dau_mau('2026-08-01T00:00:00.000Z');
  assert.match(stickinessSql, /toIntervalDay\(1\)/);
  assert.match(stickinessSql, /toIntervalDay\(30\)/);
  assert.ok(!stickinessSql.includes('2026-08-01'), 'stickiness ignores `since` on purpose');
});

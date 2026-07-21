// FILE: tests/api/admin-analytics-routes.test.js
// Route tests for /api/admin/analytics/*: auth gating, per-endpoint response shapes,
// `since` handling, the 503-when-unconfigured path, and key-secrecy. The analytics
// service is injected (no real PostHog, no DB).

import '../_helpers/test-db.js'; // MUST be first: sets ADMIN_EMAILS before env.js loads
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import jwt from 'jsonwebtoken';

import { createAdminAnalyticsRouter } from '../../src/api/admin/admin-analytics-routes.js';
import { requireSeeker, requireAdmin } from '../../src/middleware/require-seeker-middleware.js';
import { errorHandler } from '../../src/middleware/error-handler-middleware.js';
import { JWT_SECRET } from '../../src/env.js';

const ADMIN_COOKIE = `tj_token=${jwt.sign({ userId: 'admin-1', email: 'admin@jobmesh.in' }, JWT_SECRET)}`;
const SEEKER_COOKIE = `tj_token=${jwt.sign({ userId: 'seeker-1', email: 'nobody@x.com' }, JWT_SECRET)}`;

// Canned results keyed by query name so the route's shape functions have data to map.
function cannedResults(names) {
  const results = {};
  for (const name of names) {
    if (name === 'seeker_conversion_funnel') results[name] = [[10, 6, 3, 1]];
    else if (name === 'employer_conversion_funnel') results[name] = [[9, 7, 5, 4, 2]];
    else if (name.endsWith('_by_day')) results[name] = [['2026-07-01', 5], ['2026-07-02', 8]];
    else if (name === 'traffic_by_referrer') results[name] = [['google', 12], ['direct', 4]];
    else if (name === 'traffic_by_device') results[name] = [['Desktop', 9], ['Mobile', 7]];
    else results[name] = [[42]];
  }
  return results;
}

const mockService = {
  async runMany(names, sinceISO) {
    return { results: cannedResults(names), cachedAt: '2026-07-20T00:00:00.000Z', _since: sinceISO };
  },
};

function buildApp({ service = mockService } = {}) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/admin/analytics', requireSeeker, requireAdmin, createAdminAnalyticsRouter({ service }));
  app.use(errorHandler);
  return app;
}

const asAdmin = (app, url) => request(app).get(url).set('Cookie', ADMIN_COOKIE);

test('401 without an auth cookie', async () => {
  const res = await request(buildApp()).get('/api/admin/analytics/volume');
  assert.equal(res.status, 401);
});

test('403 for an authenticated non-admin seeker', async () => {
  const res = await request(buildApp()).get('/api/admin/analytics/volume').set('Cookie', SEEKER_COOKIE);
  assert.equal(res.status, 403);
});

test('200 /volume returns the volume shape', async () => {
  const res = await asAdmin(buildApp(), '/api/admin/analytics/volume');
  assert.equal(res.status, 200);
  assert.equal(res.body.result.visitorsTotal, 42);
  assert.deepEqual(res.body.result.visitorsByDay, [{ day: '2026-07-01', count: 5 }, { day: '2026-07-02', count: 8 }]);
  assert.equal(res.body.result.pageviewsTotal, 42);
  assert.ok(Array.isArray(res.body.result.pageviewsByDay));
});

test('200 /seeker returns the seeker shape including funnel', async () => {
  const res = await asAdmin(buildApp(), '/api/admin/analytics/seeker');
  assert.equal(res.status, 200);
  const r = res.body.result;
  for (const k of ['signups', 'logins', 'jobsListViews', 'jobDetailViews', 'applyStarted', 'applySubmitted', 'applySuccessViewed']) {
    assert.equal(r[k], 42, `missing ${k}`);
  }
  assert.deepEqual(r.funnel, [
    { stage: 'jobs_list_viewed', count: 10 }, { stage: 'job_viewed', count: 6 },
    { stage: 'apply_started', count: 3 }, { stage: 'apply_submitted', count: 1 },
  ]);
});

test('200 /employer returns the employer shape including funnel', async () => {
  const res = await asAdmin(buildApp(), '/api/admin/analytics/employer');
  assert.equal(res.status, 200);
  const r = res.body.result;
  for (const k of ['signups', 'logins', 'onboardingStarted', 'onboardingCompleted', 'postingsCreated', 'postingsPublished']) {
    assert.equal(r[k], 42, `missing ${k}`);
  }
  assert.equal(r.funnel.length, 5);
  assert.equal(r.funnel[0].stage, 'employer_signup_completed');
});

test('200 /engagement returns the engagement shape', async () => {
  const res = await asAdmin(buildApp(), '/api/admin/analytics/engagement');
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body.result).sort(),
    ['applicantsArchived', 'applicantsMovedStage', 'applicantsViewed', 'notesAdded']);
});

test('200 /team returns the invites shape', async () => {
  const res = await asAdmin(buildApp(), '/api/admin/analytics/team');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.result, { invitesSent: 42, invitesAccepted: 42 });
});

test('200 /traffic returns byReferrer + byDevice', async () => {
  const res = await asAdmin(buildApp(), '/api/admin/analytics/traffic');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.result.byReferrer, [{ bucket: 'google', count: 12 }, { bucket: 'direct', count: 4 }]);
  assert.deepEqual(res.body.result.byDevice, [{ device: 'Desktop', count: 9 }, { device: 'Mobile', count: 7 }]);
});

test('since=24h resolves to ~24 hours ago', async () => {
  const res = await asAdmin(buildApp(), '/api/admin/analytics/volume?since=24h');
  assert.equal(res.status, 200);
  const delta = Date.now() - Date.parse(res.body.since);
  assert.ok(Math.abs(delta - 86_400_000) < 60_000, `since not ~24h ago: ${res.body.since}`);
});

test('since defaults to 7d when omitted', async () => {
  const res = await asAdmin(buildApp(), '/api/admin/analytics/volume');
  const delta = Date.now() - Date.parse(res.body.since);
  assert.ok(Math.abs(delta - 604_800_000) < 60_000, `since not ~7d ago: ${res.body.since}`);
});

test('since=ISO is passed through', async () => {
  const iso = '2026-06-15T00:00:00.000Z';
  const res = await asAdmin(buildApp(), `/api/admin/analytics/volume?since=${encodeURIComponent(iso)}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.since, iso);
});

test('since=invalid → 400 INVALID_SINCE', async () => {
  const res = await asAdmin(buildApp(), '/api/admin/analytics/volume?since=lastweek');
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'INVALID_SINCE');
});

test('503 when the service is not configured (missing key)', async () => {
  const res = await asAdmin(buildApp({ service: null }), '/api/admin/analytics/volume');
  assert.equal(res.status, 503);
  assert.equal(res.body.code, 'ANALYTICS_DISABLED');
});

test('no response body ever contains a phx_ key', async () => {
  for (const path of ['volume', 'seeker', 'employer', 'engagement', 'team', 'traffic']) {
    const res = await asAdmin(buildApp(), `/api/admin/analytics/${path}`);
    assert.ok(!JSON.stringify(res.body).includes('phx_'), `${path} leaked a phx_ key`);
  }
});

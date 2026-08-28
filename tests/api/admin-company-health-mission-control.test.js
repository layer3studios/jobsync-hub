// FILE: tests/api/admin-company-health-mission-control.test.js
// /api/admin/companies-health and /api/admin/overview: one happy path each plus
// the auth gate. Services are injected, so no database and no live AI state.
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
import { createCompanyHealthRouter } from '../../src/api/admin/company-health-routes.js';
import { createMissionControlRouter } from '../../src/api/admin/mission-control-routes.js';
import { statusFor } from '../../src/services/admin/company-health-service.js';

const COMPANIES = [
  {
    companyId: '6a920a6631e857a1f67f3856', name: 'Acme', memberCount: 3,
    livePostingCount: 2, totalApplicants: 40, applicantsLast30d: 5,
    lastMemberLoginAt: '2026-08-28T10:00:00.000Z',
    lastActivityAt: '2026-08-27T10:00:00.000Z', status: 'active',
  },
  {
    companyId: '6a920a6631e857a1f67f3857', name: 'Quiet Co', memberCount: 1,
    livePostingCount: 0, totalApplicants: 2, applicantsLast30d: 0,
    lastMemberLoginAt: null, lastActivityAt: null, status: 'dormant',
  },
];

const OVERVIEW = {
  totals: { seekers: 500, employers: 20, companies: 12, livePostings: 8, scrapedJobs: 1000, applicationsTotal: 300 },
  newSeekers: { thisWeek: 10, prevWeek: 6, delta: 4 },
  newApplications: { thisWeek: 25, prevWeek: 30, delta: -5 },
  newPostings: { thisWeek: 2, prevWeek: 2, delta: 0 },
  weeklyApplications: [{ weekStart: '2026-07-04T00:00:00.000Z', count: 12 }],
};

const STATUS = {
  dbOk: true,
  scraperLastSuccessAt: '2026-08-29T02:00:00.000Z',
  queues: [{ key: 'resume-parse', label: 'Resume parsing', failedCount: 1, oldestPendingAgeMs: 900_000 }],
  ai: { models: [] },
  diskFreeBytes: 12_000_000_000,
};

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/admin/companies-health', requireAdmin, createCompanyHealthRouter({
    listCompanyHealth: async () => COMPANIES,
  }));
  app.use('/api/admin/overview', requireAdmin, createMissionControlRouter({
    getOverview: async () => OVERVIEW,
    getSystemStatus: async () => STATUS,
  }));
  app.use(errorHandler);
  return app;
}

/** requireAdmin re-checks isActive on every call, so a real admin row is needed. */
let cachedCookie = null;
async function adminCookie() {
  if (cachedCookie) return cachedCookie;
  const admins = await col('admin_users');
  const email = 'mission-control-admin@jobmesh.in';
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
  await (await col('admin_users')).deleteOne({ email: 'mission-control-admin@jobmesh.in' });
  await closeTestDb();
});

test('both routes reject a request with no admin cookie', async () => {
  const app = buildApp();
  assert.equal((await request(app).get('/api/admin/companies-health')).status, 401);
  assert.equal((await request(app).get('/api/admin/overview')).status, 401);
});

test('GET /companies-health returns one row per company', async () => {
  const res = await request(buildApp()).get('/api/admin/companies-health').set('Cookie', await adminCookie());
  assert.equal(res.status, 200);
  const { companies } = res.body.data;
  assert.equal(companies.length, 2);
  assert.equal(companies[0].name, 'Acme');
  assert.equal(companies[0].livePostingCount, 2);
  assert.equal(companies[1].status, 'dormant');
});

test('GET /overview returns totals, deltas, the series and the status strip', async () => {
  const res = await request(buildApp()).get('/api/admin/overview').set('Cookie', await adminCookie());
  assert.equal(res.status, 200);
  const { overview, status } = res.body.data;
  assert.equal(overview.totals.seekers, 500);
  assert.equal(overview.newApplications.delta, -5);
  assert.equal(overview.weeklyApplications.length, 1);
  assert.equal(status.dbOk, true);
  assert.equal(status.queues[0].failedCount, 1);
  assert.equal(status.diskFreeBytes, 12_000_000_000);
});

test('statusFor bands activity into active / quiet / dormant', () => {
  const now = new Date('2026-08-29T00:00:00.000Z');
  const daysAgo = (days) => new Date(now.getTime() - days * 86_400_000);
  assert.equal(statusFor(daysAgo(1), now), 'active');
  assert.equal(statusFor(daysAgo(14), now), 'active');   // boundary is inclusive
  assert.equal(statusFor(daysAgo(20), now), 'quiet');
  assert.equal(statusFor(daysAgo(45), now), 'quiet');
  assert.equal(statusFor(daysAgo(60), now), 'dormant');
  assert.equal(statusFor(null, now), 'dormant');         // never active at all
});

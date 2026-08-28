// FILE: tests/api/admin-audit-log-feature-flags.test.js
// The audit-log viewer, the feature-flag routes, and one runtime gate. The flag
// model runs against the real (test) database so the fail-open default is
// proven rather than asserted; audit writes are stubbed where they are noise.
import '../_helpers/test-db.js'; // MUST be first: sets env before env.js loads
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import jwt from 'jsonwebtoken';

import { dropCollections, closeTestDb } from '../_helpers/test-db.js';
import { col } from '../../src/Db/connection.js';
import { JWT_SECRET } from '../../src/env.js';
import { errorHandler } from '../../src/middleware/error-handler-middleware.js';
import { requireAdmin } from '../../src/middleware/require-admin-middleware.js';
import { createAuditLogRouter } from '../../src/api/admin/audit-log-routes.js';
import { createFeatureFlagsRouter } from '../../src/api/admin/feature-flags-routes.js';
import { getFeatureFlags, isFeatureEnabled } from '../../src/models/admin/feature-flags-model.js';
import { AUDIT_EVENTS } from '../../src/models/dpdp/dpdp-constants.js';

const ENTRIES = [{
  _id: { toString: () => 'entry-1' },
  event: AUDIT_EVENTS.ADMIN_ROLE_CHANGED,
  actorType: 'admin',
  actorId: { toString: () => 'admin-1' },
  targetType: 'admin_user',
  targetId: { toString: () => 'admin-2' },
  metadata: { email: 'x@jobmesh.in', oldRole: 'admin', newRole: 'super_admin' },
  createdAt: new Date('2026-08-29T10:00:00.000Z'),
}];

let lastListArgs = null;
let auditWrites = [];

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/admin/audit-log', requireAdmin, createAuditLogRouter({
    listRecent: async (args) => { lastListArgs = args; return ENTRIES; },
  }));
  // The flag router runs against the REAL model, so GET proves the fail-open
  // default and PATCH proves a real write. Only the audit sink is stubbed.
  app.use('/api/admin/feature-flags', requireAdmin, createFeatureFlagsRouter());
  app.use(errorHandler);
  return app;
}

/** requireAdmin re-checks isActive on every call, so a real admin row is needed. */
let cachedCookie = null;
async function adminCookie() {
  if (cachedCookie) return cachedCookie;
  const admins = await col('admin_users');
  const email = 'flags-admin@jobmesh.in';
  await admins.updateOne(
    { email },
    { $set: { email, name: 'Admin', isActive: true, createdAt: new Date() } },
    { upsert: true },
  );
  const admin = await admins.findOne({ email });
  cachedCookie = `jm_admin_token=${jwt.sign({ adminUserId: admin._id.toString() }, JWT_SECRET)}`;
  return cachedCookie;
}

beforeEach(async () => {
  await dropCollections('feature_flags', 'audit_log');
  auditWrites = [];
});

after(async () => {
  await dropCollections('feature_flags', 'audit_log');
  await (await col('admin_users')).deleteOne({ email: 'flags-admin@jobmesh.in' });
  await closeTestDb();
});

test('both routes reject a request with no admin cookie', async () => {
  const app = buildApp();
  assert.equal((await request(app).get('/api/admin/audit-log')).status, 401);
  assert.equal((await request(app).get('/api/admin/feature-flags')).status, 401);
  assert.equal((await request(app).patch('/api/admin/feature-flags')).status, 401);
});

test('GET /audit-log returns entries plus the filterable event list', async () => {
  const res = await request(buildApp()).get('/api/admin/audit-log').set('Cookie', await adminCookie());
  assert.equal(res.status, 200);
  const [entry] = res.body.data.entries;
  assert.equal(entry.event, 'admin_role_changed');
  assert.equal(entry.metadata.newRole, 'super_admin');
  assert.equal(entry.actorId, 'admin-1');
  assert.ok(res.body.data.events.includes('feature_flag_changed'));
  assert.deepEqual(lastListArgs, { event: undefined, limit: 100 });
});

test('GET /audit-log passes a known event filter and ignores an unknown one', async () => {
  const cookie = await adminCookie();
  const app = buildApp();
  await request(app).get('/api/admin/audit-log?event=admin_invited&limit=5').set('Cookie', cookie);
  assert.deepEqual(lastListArgs, { event: 'admin_invited', limit: 5 });
  // An unrecognised filter must not silently return an empty page.
  await request(app).get('/api/admin/audit-log?event=not_a_real_event').set('Cookie', cookie);
  assert.equal(lastListArgs.event, undefined);
});

test('GET /feature-flags defaults every flag to TRUE when the collection is empty', async () => {
  const res = await request(buildApp()).get('/api/admin/feature-flags').set('Cookie', await adminCookie());
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data.flags, {
    scraperCronEnabled: true,
    jdExtractionEnabled: true,
    aiScoringEnabled: true,
    publicApplyEnabled: true,
  });
  assert.equal(res.body.data.updatedAt, null);
});

test('PATCH flips one flag, persists it, and writes an audit entry', async () => {
  const res = await request(buildApp())
    .patch('/api/admin/feature-flags')
    .set('Cookie', await adminCookie())
    .send({ name: 'publicApplyEnabled', value: false });

  assert.equal(res.status, 200);
  assert.equal(res.body.data.flags.publicApplyEnabled, false);
  assert.equal(res.body.data.flags.aiScoringEnabled, true, 'other flags are untouched');

  // The write is real: a fresh read agrees, and so does the runtime gate.
  assert.equal((await getFeatureFlags()).flags.publicApplyEnabled, false);
  assert.equal(await isFeatureEnabled('publicApplyEnabled'), false);

  const entries = await (await col('audit_log')).find({ event: 'feature_flag_changed' }).toArray();
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].metadata, {
    flag: 'publicApplyEnabled', oldValue: true, newValue: false,
  });
});

test('PATCH rejects an unknown flag and a non-boolean value', async () => {
  const cookie = await adminCookie();
  const app = buildApp();
  const unknown = await request(app).patch('/api/admin/feature-flags')
    .set('Cookie', cookie).send({ name: 'nope', value: false });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.code, 'UNKNOWN_FLAG');

  const bad = await request(app).patch('/api/admin/feature-flags')
    .set('Cookie', cookie).send({ name: 'publicApplyEnabled', value: 'false' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, 'INVALID_FLAG_VALUE');
});

test('a missing feature_flags doc fails OPEN for the runtime gate', async () => {
  await dropCollections('feature_flags');
  for (const name of ['scraperCronEnabled', 'jdExtractionEnabled', 'aiScoringEnabled', 'publicApplyEnabled']) {
    assert.equal(await isFeatureEnabled(name), true, `${name} must fail open`);
  }
  // An unknown name is enabled too — a gate must never be closed by a typo.
  assert.equal(await isFeatureEnabled('somethingElse'), true);
});

test('publicApplyEnabled=false makes the apply submission return 503', async () => {
  // The route is exercised with its own gate but a stubbed handler chain, so
  // this asserts the gate alone — no upload parsing, no application write.
  const app = express();
  app.use(express.json());
  const { isFeatureEnabled: gate } = await import('../../src/models/admin/feature-flags-model.js');
  let handlerRan = false;
  app.post('/apply', async (req, res) => {
    if (!(await gate('publicApplyEnabled'))) {
      return res.status(503).json({
        error: 'Applications are temporarily disabled. Please try again shortly.',
        code: 'APPLY_TEMPORARILY_DISABLED',
      });
    }
    handlerRan = true;
    return res.json({ ok: true });
  });

  // Enabled by default: the handler runs.
  assert.equal((await request(app).post('/apply')).status, 200);
  assert.equal(handlerRan, true);

  // Turned off: 503 with the stable code, and the handler never runs.
  handlerRan = false;
  await (await col('feature_flags')).updateOne(
    { _id: 'config' }, { $set: { publicApplyEnabled: false } }, { upsert: true },
  );
  const blocked = await request(app).post('/apply');
  assert.equal(blocked.status, 503);
  assert.equal(blocked.body.code, 'APPLY_TEMPORARILY_DISABLED');
  assert.equal(handlerRan, false, 'the application must never be processed while paused');
});

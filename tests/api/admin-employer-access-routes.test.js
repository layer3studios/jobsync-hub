// FILE: tests/api/admin-employer-access-routes.test.js
import './../_helpers/test-db.js';
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { ObjectId } from 'mongodb';

import { dropCollections, closeTestDb } from '../_helpers/test-db.js';
import adminRouter from '../../src/api/admin/admin-routes.js';
import { errorHandler } from '../../src/middleware/error-handler-middleware.js';
import { JWT_SECRET } from '../../src/env.js';
import { ensureEmployerAccessIndexes } from '../../src/models/employer/index.js';
import { ensureAdminUserIndexes, upsertAdminByEmail } from '../../src/models/admin/index.js';

// Admin auth is now MongoDB-backed (admin_users) + jm_admin_token (feat/admin-identity).
// Each reset seeds an active admin and signs a token for it. A jm_admin_token whose
// row is absent yields 403; a request with no admin cookie yields 401.
let ADMIN_COOKIE;
const NON_ADMIN_COOKIE = `jm_admin_token=${jwt.sign({ adminUserId: new ObjectId().toString() }, JWT_SECRET, { expiresIn: '8h' })}`;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/admin', adminRouter);
  app.use(errorHandler);
  return app;
}

const asAdmin = (app, method, url) => request(app)[method](url).set('Cookie', ADMIN_COOKIE);

async function reset() {
  await dropCollections('employer_access', 'admin_users');
  await ensureEmployerAccessIndexes();
  await ensureAdminUserIndexes();
  const admin = await upsertAdminByEmail({ email: 'admin@jobmesh.in', role: 'super_admin' });
  ADMIN_COOKIE = `jm_admin_token=${jwt.sign({ adminUserId: admin._id.toString() }, JWT_SECRET, { expiresIn: '8h' })}`;
}

before(reset);
beforeEach(reset);
after(async () => { await closeTestDb(); });

test('unauthenticated request → 401', async () => {
  const res = await request(buildApp()).get('/api/admin/employer-access');
  assert.equal(res.status, 401);
});

test('valid admin token but no admin_users row → 403', async () => {
  const res = await request(buildApp()).get('/api/admin/employer-access').set('Cookie', NON_ADMIN_COOKIE);
  assert.equal(res.status, 403);
});

test('GET returns default-deny shape when no config doc exists', async () => {
  const res = await asAdmin(buildApp(), 'get', '/api/admin/employer-access');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data, { isEmployerSignupOpen: false, whitelist: [] });
});

test('POST /toggle with a non-boolean → 400', async () => {
  const res = await asAdmin(buildApp(), 'post', '/api/admin/employer-access/toggle').send({ isEmployerSignupOpen: 'yes' });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'INVALID_TOGGLE_VALUE');
});

test('POST /toggle flips and persists', async () => {
  const app = buildApp();
  const toggled = await asAdmin(app, 'post', '/api/admin/employer-access/toggle').send({ isEmployerSignupOpen: true });
  assert.equal(toggled.status, 200);
  assert.equal(toggled.body.data.isEmployerSignupOpen, true);
  const fetched = await asAdmin(app, 'get', '/api/admin/employer-access');
  assert.equal(fetched.body.data.isEmployerSignupOpen, true);
});

test('POST /whitelist with an invalid email → 400', async () => {
  const res = await asAdmin(buildApp(), 'post', '/api/admin/employer-access/whitelist').send({ email: 'not-an-email' });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'INVALID_EMAIL');
});

test('POST /whitelist is idempotent across casing', async () => {
  const app = buildApp();
  await asAdmin(app, 'post', '/api/admin/employer-access/whitelist').send({ email: 'dup@x.com' });
  const second = await asAdmin(app, 'post', '/api/admin/employer-access/whitelist').send({ email: 'DUP@X.com' });
  assert.equal(second.status, 200);
  const listed = await asAdmin(app, 'get', '/api/admin/employer-access');
  assert.equal(listed.body.data.whitelist.length, 1);
});

test('DELETE /whitelist/:email is idempotent on a missing entry', async () => {
  const res = await asAdmin(buildApp(), 'delete', '/api/admin/employer-access/whitelist/ghost@x.com');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data, { deleted: true });
});

test('DELETE accepts a URL-encoded email and removes it', async () => {
  const app = buildApp();
  await asAdmin(app, 'post', '/api/admin/employer-access/whitelist').send({ email: 'gone@x.com' });
  const encoded = encodeURIComponent('GONE@x.com');
  const res = await asAdmin(app, 'delete', `/api/admin/employer-access/whitelist/${encoded}`);
  assert.equal(res.status, 200);
  const listed = await asAdmin(app, 'get', '/api/admin/employer-access');
  assert.equal(listed.body.data.whitelist.length, 0);
});

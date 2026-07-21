// FILE: tests/middleware/require-admin-middleware.test.js
import './../_helpers/test-db.js';
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { ObjectId } from 'mongodb';

import { dropCollections, closeTestDb } from '../_helpers/test-db.js';
import { col } from '../../src/Db/connection.js';
import { JWT_SECRET } from '../../src/env.js';
import { requireAdmin } from '../../src/middleware/require-admin-middleware.js';
import { errorHandler } from '../../src/middleware/error-handler-middleware.js';
import { ensureAdminUserIndexes, upsertAdminByEmail } from '../../src/models/admin/index.js';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.get('/probe', requireAdmin, (req, res) => res.json({ adminUser: req.adminUser }));
  app.use(errorHandler);
  return app;
}

const adminCookie = (token) => `jm_admin_token=${token}`;
const signAdmin = (payload, options) => jwt.sign(payload, JWT_SECRET, options);

async function reset() {
  await dropCollections('admin_users');
  await ensureAdminUserIndexes();
}
before(reset);
beforeEach(reset);
after(async () => { await closeTestDb(); });

test('missing jm_admin_token cookie → 401', async () => {
  const res = await request(buildApp()).get('/probe');
  assert.equal(res.status, 401);
});

test('malformed JWT → 401', async () => {
  const res = await request(buildApp()).get('/probe').set('Cookie', adminCookie('not-a-jwt'));
  assert.equal(res.status, 401);
});

test('expired JWT → 401', async () => {
  const token = signAdmin({ adminUserId: new ObjectId().toString() }, { expiresIn: '-1s' });
  const res = await request(buildApp()).get('/probe').set('Cookie', adminCookie(token));
  assert.equal(res.status, 401);
});

test('JWT payload missing adminUserId → 401', async () => {
  const token = signAdmin({ email: 'x@y.com' }, { expiresIn: '8h' });
  const res = await request(buildApp()).get('/probe').set('Cookie', adminCookie(token));
  assert.equal(res.status, 401);
});

test('valid JWT but no admin_users row → 403', async () => {
  const token = signAdmin({ adminUserId: new ObjectId().toString() }, { expiresIn: '8h' });
  const res = await request(buildApp()).get('/probe').set('Cookie', adminCookie(token));
  assert.equal(res.status, 403);
});

test('valid JWT, row exists but isActive:false → 403', async () => {
  const row = await upsertAdminByEmail({ email: 'inactive@x.com' });
  await (await col('admin_users')).updateOne({ _id: row._id }, { $set: { isActive: false } });
  const token = signAdmin({ adminUserId: row._id.toString() }, { expiresIn: '8h' });
  const res = await request(buildApp()).get('/probe').set('Cookie', adminCookie(token));
  assert.equal(res.status, 403);
});

test('valid JWT + active row → next() and req.adminUser attached', async () => {
  const row = await upsertAdminByEmail({ email: 'active@x.com', role: 'super_admin' });
  const token = signAdmin({ adminUserId: row._id.toString() }, { expiresIn: '8h' });
  const res = await request(buildApp()).get('/probe').set('Cookie', adminCookie(token));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.adminUser, {
    adminUserId: row._id.toString(), email: 'active@x.com', role: 'super_admin',
  });
});

test('a tj_token cookie does NOT authenticate as admin (regression)', async () => {
  const seekerToken = signAdmin({ userId: 'seeker-1', email: 'admin@x.com' }, { expiresIn: '8h' });
  const res = await request(buildApp()).get('/probe').set('Cookie', `tj_token=${seekerToken}`);
  assert.equal(res.status, 401); // no jm_admin_token → unauthorized
});

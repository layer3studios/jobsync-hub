// FILE: tests/api/admin-auth-routes.test.js
import './../_helpers/test-db.js';
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import jwt from 'jsonwebtoken';

import { dropCollections, closeTestDb } from '../_helpers/test-db.js';
import { col } from '../../src/Db/connection.js';
import { JWT_SECRET } from '../../src/env.js';
import { createAdminAuthRouter } from '../../src/api/admin/admin-auth-routes.js';
import { errorHandler, HttpError } from '../../src/middleware/error-handler-middleware.js';
import { ensureAdminUserIndexes, upsertAdminByEmail, findAdminById } from '../../src/models/admin/index.js';

const PROFILE = { googleId: 'g-admin', email: 'admin@x.com', name: 'Admin', picture: null };
const stubReturning = (profile) => async () => profile;
const stubThrowing = (status, message, code) => async () => { throw new HttpError(status, message, code); };

function buildApp(verifyToken) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/admin/auth', createAdminAuthRouter(verifyToken ? { verifyToken } : undefined));
  app.use(errorHandler);
  return app;
}

async function reset() {
  await dropCollections('admin_users');
  await ensureAdminUserIndexes();
}
before(reset);
beforeEach(reset);
after(async () => { await closeTestDb(); });

test('POST /google with no idToken → 400', async () => {
  const res = await request(buildApp()).post('/api/admin/auth/google').send({});
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'MISSING_ID_TOKEN');
});

test('POST /google when Google verification fails → 401', async () => {
  const app = buildApp(stubThrowing(401, 'Invalid Google token', 'INVALID_GOOGLE_TOKEN'));
  const res = await request(app).post('/api/admin/auth/google').send({ idToken: 'x' });
  assert.equal(res.status, 401);
  assert.equal(res.body.code, 'INVALID_GOOGLE_TOKEN');
});

test('POST /google, email not in admin_users → 403 Not an admin', async () => {
  const app = buildApp(stubReturning(PROFILE));
  const res = await request(app).post('/api/admin/auth/google').send({ idToken: 'x' });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'NOT_AN_ADMIN');
});

test('POST /google, row exists but isActive:false → 403', async () => {
  const row = await upsertAdminByEmail({ email: PROFILE.email });
  await (await col('admin_users')).updateOne({ _id: row._id }, { $set: { isActive: false } });
  const app = buildApp(stubReturning(PROFILE));
  const res = await request(app).post('/api/admin/auth/google').send({ idToken: 'x' });
  assert.equal(res.status, 403);
});

test('POST /google with an active admin → 200, admin body + jm_admin_token cookie', async () => {
  const row = await upsertAdminByEmail({ email: PROFILE.email, role: 'super_admin' });
  const app = buildApp(stubReturning(PROFILE));
  const res = await request(app).post('/api/admin/auth/google').send({ idToken: 'x' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.admin, {
    adminUserId: row._id.toString(), email: PROFILE.email, role: 'super_admin',
  });
  const setCookie = (res.headers['set-cookie'] || []).join(';');
  assert.match(setCookie, /jm_admin_token=/);
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /Path=\//);
});

test('POST /google updates lastLoginAt on success', async () => {
  const row = await upsertAdminByEmail({ email: PROFILE.email });
  assert.equal(row.lastLoginAt, null);
  const app = buildApp(stubReturning(PROFILE));
  await request(app).post('/api/admin/auth/google').send({ idToken: 'x' });
  const after = await findAdminById(row._id);
  assert.ok(after.lastLoginAt instanceof Date);
});

test('GET /me without cookie → 401', async () => {
  const res = await request(buildApp()).get('/api/admin/auth/me');
  assert.equal(res.status, 401);
});

test('GET /me with a valid cookie → 200 admin identity', async () => {
  const row = await upsertAdminByEmail({ email: PROFILE.email, role: 'admin' });
  const token = jwt.sign(
    { adminUserId: row._id.toString(), email: PROFILE.email, role: 'admin' }, JWT_SECRET, { expiresIn: '8h' },
  );
  const res = await request(buildApp()).get('/api/admin/auth/me').set('Cookie', `jm_admin_token=${token}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.admin.email, PROFILE.email);
  assert.equal(res.body.admin.adminUserId, row._id.toString());
});

test('POST /google with valid inviteToken + matching email activates the row → 200', async () => {
  const inviter = await upsertAdminByEmail({ email: 'super@x.com', role: 'super_admin' });
  const { createAdminInvite } = await import('../../src/models/admin/index.js');
  const pending = await createAdminInvite({ email: PROFILE.email, role: 'admin', invitedByAdminUserId: inviter._id });

  const app = buildApp(stubReturning(PROFILE));
  const res = await request(app).post('/api/admin/auth/google').send({ idToken: 'x', inviteToken: pending.inviteToken });
  assert.equal(res.status, 200);
  assert.equal(res.body.admin.email, PROFILE.email);
  const after = await findAdminById(pending._id); // findAdminById only returns ACTIVE rows
  assert.ok(after, 'row is now active');
  assert.equal(after.inviteToken, undefined);
  assert.ok(after.activatedAt instanceof Date);
  const setCookie = (res.headers['set-cookie'] || []).join(';');
  assert.match(setCookie, /jm_admin_token=/);
});

test('POST /google with valid inviteToken but mismatched email → 403 INVITE_EMAIL_MISMATCH', async () => {
  const inviter = await upsertAdminByEmail({ email: 'super@x.com', role: 'super_admin' });
  const { createAdminInvite } = await import('../../src/models/admin/index.js');
  const pending = await createAdminInvite({ email: 'someone-else@x.com', role: 'admin', invitedByAdminUserId: inviter._id });

  const app = buildApp(stubReturning(PROFILE)); // Google verifies admin@x.com, invite is for someone-else
  const res = await request(app).post('/api/admin/auth/google').send({ idToken: 'x', inviteToken: pending.inviteToken });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'INVITE_EMAIL_MISMATCH');
});

test('POST /google with expired inviteToken → 403 INVITE_INVALID', async () => {
  const inviter = await upsertAdminByEmail({ email: 'super@x.com', role: 'super_admin' });
  const { createAdminInvite } = await import('../../src/models/admin/index.js');
  const pending = await createAdminInvite({ email: PROFILE.email, role: 'admin', invitedByAdminUserId: inviter._id });
  await (await col('admin_users')).updateOne({ _id: pending._id }, { $set: { inviteExpiresAt: new Date(Date.now() - 1000) } });

  const app = buildApp(stubReturning(PROFILE));
  const res = await request(app).post('/api/admin/auth/google').send({ idToken: 'x', inviteToken: pending.inviteToken });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'INVITE_INVALID');
});

test('POST /logout clears the jm_admin_token cookie', async () => {
  const res = await request(buildApp()).post('/api/admin/auth/logout');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  const setCookie = (res.headers['set-cookie'] || []).join(';');
  assert.match(setCookie, /jm_admin_token=/);
});

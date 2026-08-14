// FILE: tests/api/employer-auth-routes.test.js
import './../_helpers/test-db.js';
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';

import { dropCollections, closeTestDb } from '../_helpers/test-db.js';
import { createEmployerAuthRouter } from '../../src/api/employer/employer-auth-routes.js';
import { errorHandler } from '../../src/middleware/error-handler-middleware.js';
import { HttpError } from '../../src/middleware/error-handler-middleware.js';
import {
  ensureEmployerAccessIndexes,
  ensureEmployerUserIndexes,
  setEmployerSignupOpen,
  addEmployerAccessWhitelistEntry,
} from '../../src/models/employer/index.js';

const PROFILE = { googleId: 'g-owner', email: 'owner@acme.com', name: 'Owner', picture: null };

function buildApp(verifyToken) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/employer/auth', createEmployerAuthRouter(verifyToken ? { verifyToken } : undefined));
  app.use(errorHandler);
  return app;
}

const stubReturning = (profile) => async () => profile;
const stubThrowing = (status, message, code) => async () => { throw new HttpError(status, message, code); };

before(async () => {
  await dropCollections('employer_access', 'employer_users');
  await ensureEmployerAccessIndexes();
  await ensureEmployerUserIndexes();
});

beforeEach(async () => {
  await dropCollections('employer_access', 'employer_users');
  await ensureEmployerAccessIndexes();
  await ensureEmployerUserIndexes();
});

after(async () => {
  await closeTestDb();
});

test('POST /google with no body → 400 MISSING_CREDENTIAL', async () => {
  const res = await request(buildApp()).post('/api/employer/auth/google').send({});
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'MISSING_CREDENTIAL');
});

test('POST /google with an invalid token → 401 INVALID_GOOGLE_TOKEN', async () => {
  const app = buildApp(stubThrowing(401, 'Invalid Google token', 'INVALID_GOOGLE_TOKEN'));
  const res = await request(app).post('/api/employer/auth/google').send({ credential: 'x' });
  assert.equal(res.status, 401);
  assert.equal(res.body.code, 'INVALID_GOOGLE_TOKEN');
});

test('POST /google, gate closed + not whitelisted → 403 EMPLOYER_SIGNUP_GATED', async () => {
  const app = buildApp(stubReturning(PROFILE));
  const res = await request(app).post('/api/employer/auth/google').send({ credential: 'x' });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'EMPLOYER_SIGNUP_GATED');
});

test('POST /google, gate closed + whitelisted → 200 and sets cookie', async () => {
  await addEmployerAccessWhitelistEntry(PROFILE.email, null, null);
  const app = buildApp(stubReturning(PROFILE));
  const res = await request(app).post('/api/employer/auth/google').send({ credential: 'x' });
  assert.equal(res.status, 200);
  const cookies = res.headers['set-cookie'].join(';');
  assert.match(cookies, /jm_employer_token=/);
});

test('POST /google, gate open → 200 for any email', async () => {
  await setEmployerSignupOpen(true, null);
  const app = buildApp(stubReturning({ ...PROFILE, email: 'random@elsewhere.com', googleId: 'g-r' }));
  const res = await request(app).post('/api/employer/auth/google').send({ credential: 'x' });
  assert.equal(res.status, 200);
});

test('POST /google response exposes only safe fields (no googleId)', async () => {
  await setEmployerSignupOpen(true, null);
  const app = buildApp(stubReturning(PROFILE));
  const res = await request(app).post('/api/employer/auth/google').send({ credential: 'x' });
  // The full allowlist, asserted exactly so a new field cannot be added to the
  // projection without someone deciding here that it is safe to expose.
  assert.deepEqual(
    Object.keys(res.body.employerUser).sort(),
    [
      'avatarUrl', 'companyId', 'email', 'id', 'jobTitle', 'name',
      'notificationPreferences', 'picture', 'timezone',
    ],
  );
  assert.equal(res.body.employerUser.googleId, undefined);
});

test('GET /me with a valid cookie → 200; no cookie → 401', async () => {
  await setEmployerSignupOpen(true, null);
  const app = buildApp(stubReturning(PROFILE));
  const agent = request.agent(app);
  await agent.post('/api/employer/auth/google').send({ credential: 'x' });
  const me = await agent.get('/api/employer/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.employerUser.email, PROFILE.email);

  const anon = await request(app).get('/api/employer/auth/me');
  assert.equal(anon.status, 401);
});

test('GET /me with only a seeker tj_token → 401 (cross-cookie isolation)', async () => {
  const app = buildApp(stubReturning(PROFILE));
  const res = await request(app).get('/api/employer/auth/me').set('Cookie', 'tj_token=whatever');
  assert.equal(res.status, 401);
});

test('POST /logout clears the cookie', async () => {
  const res = await request(buildApp()).post('/api/employer/auth/logout');
  assert.equal(res.status, 200);
  const cookies = res.headers['set-cookie'].join(';');
  assert.match(cookies, /jm_employer_token=/);
  assert.match(cookies, /Expires=Thu, 01 Jan 1970|Max-Age=0/);
});

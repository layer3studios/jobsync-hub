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
import { errorHandler } from '../../src/middleware/error-handler-middleware.js';
import { requireSeeker } from '../../src/middleware/require-seeker-middleware.js';
import profileRouter from '../../src/api/seeker/seeker-profile-routes.js';

const USER = new ObjectId();

function cookie() { return `tj_token=${jwt.sign({ userId: USER.toString(), email: 's@x.com' }, JWT_SECRET)}`; }
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/seeker/profile', requireSeeker, profileRouter);
  app.use(errorHandler);
  return app;
}

before(async () => { await reset(); });
beforeEach(async () => { await reset(); });
after(async () => { await closeTestDb(); });
async function reset() {
  await dropCollections('users');
  const users = await col('users');
  await users.insertOne({ _id: USER, name: 'A', appliedJobs: [] });
}

test('GET / without a parsed profile → { profile: null }', async () => {
  const res = await request(buildApp()).get('/api/seeker/profile').set('Cookie', cookie());
  assert.equal(res.status, 200);
  assert.equal(res.body.profile, null);
});

test('GET / with a profile → { profile: {...} }', async () => {
  const users = await col('users');
  await users.updateOne({ _id: USER }, { $set: { parsedProfile: { fullName: 'Asha' } } });
  const res = await request(buildApp()).get('/api/seeker/profile').set('Cookie', cookie());
  assert.equal(res.body.profile.fullName, 'Asha');
});

test('GET / returns the { profile, meta } envelope shape (FIX-01 B2)', async () => {
  const res = await request(buildApp()).get('/api/seeker/profile').set('Cookie', cookie());
  assert.equal(res.status, 200);
  assert.ok('profile' in res.body); // top-level key preserved (V7 backward compat)
  assert.ok('meta' in res.body);
  assert.deepEqual(res.body.meta, {
    profileParsedAt: null, profileUpdatedAt: null, hasResumeOnFile: false,
  });
});

test('GET / meta.hasResumeOnFile true + ISO timestamps after a hashed upsert', async () => {
  const users = await col('users');
  const now = new Date();
  await users.updateOne({ _id: USER }, {
    $set: { parsedProfile: { fullName: 'Asha' }, lastResumeHash: 'hash-abc', profileParsedAt: now, profileUpdatedAt: now },
  });
  const res = await request(buildApp()).get('/api/seeker/profile').set('Cookie', cookie());
  assert.equal(res.body.meta.hasResumeOnFile, true);
  assert.equal(res.body.meta.profileParsedAt, now.toISOString());
});

test('GET / meta.hasResumeOnFile false for a legacy profile without a hash', async () => {
  const users = await col('users');
  await users.updateOne({ _id: USER }, {
    $set: { parsedProfile: { fullName: 'Asha' }, profileParsedAt: new Date() },
  });
  const res = await request(buildApp()).get('/api/seeker/profile').set('Cookie', cookie());
  assert.equal(res.body.profile.fullName, 'Asha');
  assert.equal(res.body.meta.hasResumeOnFile, false);
  assert.equal(typeof res.body.meta.profileParsedAt, 'string');
});

test('PATCH / updates specific fields', async () => {
  const users = await col('users');
  await users.updateOne({ _id: USER }, { $set: { parsedProfile: { fullName: 'Asha', noticePeriod: '30 days' } } });
  const res = await request(buildApp()).patch('/api/seeker/profile').set('Cookie', cookie())
    .send({ fullName: 'Asha Rao', noticePeriod: 'Immediate' });
  assert.equal(res.status, 200);
  assert.equal(res.body.profile.fullName, 'Asha Rao');
  assert.equal(res.body.profile.noticePeriod, 'Immediate');
});

test('PATCH / with an unknown key → 400 UNKNOWN_FIELD', async () => {
  const res = await request(buildApp()).patch('/api/seeker/profile').set('Cookie', cookie())
    .send({ isAdmin: true });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'UNKNOWN_FIELD');
});

test('PATCH / without auth → 401', async () => {
  const res = await request(buildApp()).patch('/api/seeker/profile').send({ fullName: 'X' });
  assert.equal(res.status, 401);
});

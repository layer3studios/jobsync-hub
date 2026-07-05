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
import marketRouter from '../../src/api/seeker/seeker-market-routes.js';
import { marketCache } from '../../src/services/seeker/market-cache.js';

const USER = new ObjectId();
const PROFILE = { skills: [{ name: 'React' }, { name: 'Node' }], totalExperienceYears: 3, seniorityLevel: 'Mid' };

function cookie() { return `tj_token=${jwt.sign({ userId: USER.toString(), email: 's@x.com' }, JWT_SECRET)}`; }
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/seeker/market', requireSeeker, marketRouter);
  app.use(errorHandler);
  return app;
}

function scraped(location) {
  return {
    Status: 'active', PostedDate: new Date(), Location: location,
    autoTags: { roleCategory: 'Engineering' },
    parsedRequirements: {
      required_skills: ['ReactJS', 'NodeJS'], preferred_skills: [],
      min_experience_years: 2, max_experience_years: 5,
      experience_level: 'Mid', salary_range_inferred: { min: 10, max: 20, currency: 'INR', unit: 'LPA' },
    },
  };
}

before(async () => { await reset(); });
beforeEach(async () => { await reset(); });
after(async () => { await closeTestDb(); });

async function reset() {
  marketCache.clear();
  await dropCollections('users', 'jobs');
  const users = await col('users');
  await users.insertOne({ _id: USER, parsedProfile: PROFILE });
  const jobs = await col('jobs');
  await jobs.insertMany([scraped('Bangalore'), scraped('Bangalore'), scraped('Mumbai')]);
}

test('GET /match-count unauthenticated → 401', async () => {
  const res = await request(buildApp()).get('/api/seeker/market/match-count');
  assert.equal(res.status, 401);
});

test('GET /match-count with profile → 200 shape', async () => {
  const res = await request(buildApp()).get('/api/seeker/market/match-count').set('Cookie', cookie());
  assert.equal(res.status, 200);
  assert.equal(res.body.count, 3);
  assert.ok(Array.isArray(res.body.breakdown.byLocation));
  assert.ok(typeof res.body.asOf === 'string');
});

test('GET /match-count?location=Bangalore → filtered count', async () => {
  const res = await request(buildApp())
    .get('/api/seeker/market/match-count?location=Bangalore').set('Cookie', cookie());
  assert.equal(res.status, 200);
  assert.equal(res.body.count, 2);
});

test('GET /salary-benchmark unauthenticated → 401', async () => {
  const res = await request(buildApp()).get('/api/seeker/market/salary-benchmark');
  assert.equal(res.status, 401);
});

test('GET /salary-benchmark with a small sample → null percentiles surfaced', async () => {
  const res = await request(buildApp()).get('/api/seeker/market/salary-benchmark').set('Cookie', cookie());
  assert.equal(res.status, 200);
  assert.equal(res.body.p25, null);
  assert.equal(res.body.p50, null);
  assert.equal(res.body.sampleSize, 3);
  assert.equal(res.body.unit, 'LPA');
});

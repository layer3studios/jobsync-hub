import './../_helpers/test-db.js';
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';

import { dropCollections, closeTestDb } from '../_helpers/test-db.js';
import { col } from '../../src/Db/connection.js';
import { getSalaryBenchmarkForUser } from '../../src/services/seeker/salary-benchmark-service.js';
import { marketCache } from '../../src/services/seeker/market-cache.js';

const USER = new ObjectId();
const OTHER = new ObjectId();
const MID_PROFILE = { skills: [{ name: 'React' }], totalExperienceYears: 3, seniorityLevel: 'Mid' };

function salaryJob(level, min, max) {
  return {
    Status: 'active', PostedDate: new Date(), Location: 'Bangalore',
    parsedRequirements: {
      required_skills: ['React'], preferred_skills: [],
      experience_level: level,
      salary_range_inferred: { min, max, currency: 'INR', unit: 'LPA' },
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
  await users.insertOne({ _id: USER, parsedProfile: MID_PROFILE });
}

test('no profile → 400 NO_PROFILE', async () => {
  await assert.rejects(
    () => getSalaryBenchmarkForUser(OTHER.toString()),
    (err) => err.status === 400 && err.code === 'NO_PROFILE',
  );
});

test('sampleSize < 10 → null percentiles, sampleSize reported', async () => {
  const jobs = await col('jobs');
  await jobs.insertMany([salaryJob('Mid', 10, 20), salaryJob('Mid', 12, 18)]);
  const res = await getSalaryBenchmarkForUser(USER.toString());
  assert.equal(res.sampleSize, 2);
  assert.equal(res.p25, null);
  assert.equal(res.p50, null);
  assert.equal(res.p75, null);
  assert.equal(res.currency, 'INR');
  assert.equal(res.unit, 'LPA');
});

test('sampleSize >= 10 → percentiles rounded to 0.5', async () => {
  const jobs = await col('jobs');
  // midpoints 5..14 LPA (min=max so midpoint is exact).
  const docs = [];
  for (let lpa = 5; lpa <= 14; lpa += 1) docs.push(salaryJob('Mid', lpa, lpa));
  await jobs.insertMany(docs);
  const res = await getSalaryBenchmarkForUser(USER.toString());
  assert.equal(res.sampleSize, 10);
  for (const p of [res.p25, res.p50, res.p75]) {
    assert.equal(p * 2, Math.round(p * 2)); // multiple of 0.5
  }
  assert.ok(res.p25 <= res.p50 && res.p50 <= res.p75);
});

test('seniority filter: a mid profile does not draw from the senior pool', async () => {
  const jobs = await col('jobs');
  const docs = [];
  for (let i = 0; i < 12; i += 1) docs.push(salaryJob('Senior', 40, 60));
  await jobs.insertMany(docs);
  const res = await getSalaryBenchmarkForUser(USER.toString());
  assert.equal(res.sampleSize, 0); // no Mid-level salary jobs
  assert.equal(res.filters.seniority, 'Mid');
});

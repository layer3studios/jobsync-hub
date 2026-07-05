import './../_helpers/test-db.js';
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';

import { dropCollections, closeTestDb } from '../_helpers/test-db.js';
import { col } from '../../src/Db/connection.js';
import { getMatchCountForUser } from '../../src/services/seeker/match-count-service.js';
import { marketCache } from '../../src/services/seeker/market-cache.js';

const USER = new ObjectId();
const OTHER = new ObjectId();
const PROFILE = { skills: [{ name: 'React' }, { name: 'Node' }, { name: 'AWS' }], totalExperienceYears: 3 };

function scraped(location) {
  return {
    Status: 'active', PostedDate: new Date(), Location: location,
    autoTags: { roleCategory: 'Engineering' },
    parsedRequirements: {
      required_skills: ['ReactJS', 'NodeJS'], preferred_skills: [],
      min_experience_years: 2, max_experience_years: 5,
    },
  };
}

function native(location) {
  return {
    source: 'native', status: 'active', postedAt: new Date(), location,
    parsedRequirements: {
      required_skills: ['react', 'node'], preferred_skills: [],
      min_experience_years: 1, max_experience_years: 6,
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
}

test('no profile → 400 NO_PROFILE', async () => {
  await assert.rejects(
    () => getMatchCountForUser(OTHER.toString()),
    (err) => err.status === 400 && err.code === 'NO_PROFILE',
  );
});

test('empty pool → count 0 with empty breakdown', async () => {
  const res = await getMatchCountForUser(USER.toString());
  assert.equal(res.count, 0);
  assert.deepEqual(res.breakdown, { byLocation: [], byRoleCategory: [] });
});

test('mixed pool: 1 native + 2 scraped → count 3', async () => {
  const jobs = await col('jobs');
  await jobs.insertMany([native('Bangalore'), scraped('Bangalore'), scraped('Mumbai')]);
  const res = await getMatchCountForUser(USER.toString());
  assert.equal(res.count, 3);
  const bengaluru = res.breakdown.byLocation.find((b) => b.key === 'Bangalore');
  assert.equal(bengaluru.count, 2);
});

test('location filter narrows the count', async () => {
  const jobs = await col('jobs');
  await jobs.insertMany([scraped('Bangalore'), scraped('Bangalore'), scraped('Mumbai')]);
  const res = await getMatchCountForUser(USER.toString(), { location: 'Bangalore' });
  assert.equal(res.count, 2);
});

test('cache hit: second call within TTL does not re-read the DB', async () => {
  const jobs = await col('jobs');
  await jobs.insertMany([scraped('Bangalore'), scraped('Mumbai')]);
  const first = await getMatchCountForUser(USER.toString());
  assert.equal(first.count, 2);
  await jobs.deleteMany({}); // DB now empty; a re-read would return 0
  const second = await getMatchCountForUser(USER.toString());
  assert.equal(second.count, 2); // served from cache
});

test('cache isolation: user A hit never surfaces for user B', async () => {
  const users = await col('users');
  await users.insertOne({ _id: OTHER, parsedProfile: { skills: [{ name: 'COBOL' }], totalExperienceYears: 3 } });
  const jobs = await col('jobs');
  await jobs.insertMany([scraped('Bangalore'), scraped('Mumbai')]);
  const a = await getMatchCountForUser(USER.toString());
  const b = await getMatchCountForUser(OTHER.toString());
  assert.equal(a.count, 2);
  assert.equal(b.count, 0); // COBOL matches nothing — not user A's cached 2
});

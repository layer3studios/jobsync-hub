// FILE: tests/models/posting-model-jobid-collision.test.js
// Regression guard for the JobID:null collision that blocked every employer
// after the first native posting existed. The shared `jobs` collection carries
// BOTH scraped jobs (which have JobID) and native postings (which do not).
// MongoDB indexes a missing field as null, so a plain unique index on
// { JobID: 1 } allows exactly ONE document without JobID collection-wide.
//
// These tests call ensureJobIndexes() — the real boot path — alongside
// ensurePostingIndexes(). Existing posting tests only call the latter, which is
// precisely why this never surfaced in CI.

import './../_helpers/test-db.js';
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { dropCollections, closeTestDb } from '../_helpers/test-db.js';
import { col } from '../../src/Db/connection.js';
import { ensureJobIndexes, JOB_ID_UNIQUE_INDEX_NAME } from '../../src/models/shared/job-model.js';
import { ensurePostingIndexes, createPostingForCompany } from '../../src/models/employer/posting-model.js';
import { repairJobsJobIdIndex } from '../../src/scripts/repair-jobs-jobid-index.js';

/** Every index keyed on exactly { JobID: 1 } (never the sourceSite compound). */
async function soleJobIdIndexes() {
  const jobs = await col('jobs');
  return (await jobs.indexes()).filter((index) => {
    const keys = Object.keys(index.key);
    return keys.length === 1 && keys[0] === 'JobID';
  });
}

function input(overrides = {}) {
  return {
    title: 'React Developer', description: 'x'.repeat(60), location: 'Bangalore',
    workplaceType: 'remote', employmentType: 'full-time', ...overrides,
  };
}

/** Reset `jobs` and run BOTH index builders, exactly as server boot does. */
async function resetWithBootIndexes() {
  await dropCollections('jobs');
  await ensureJobIndexes();
  await ensurePostingIndexes();
}

before(async () => { await resetWithBootIndexes(); });
beforeEach(async () => { await resetWithBootIndexes(); });
after(async () => { await closeTestDb(); });

// D5(a) — THE proof of diagnosis.
test('two native postings for DIFFERENT companies both insert (no JobID:null collision)', async () => {
  const first = await createPostingForCompany(new ObjectId(), input(), new ObjectId());
  const second = await createPostingForCompany(new ObjectId(), input(), new ObjectId());
  assert.equal(first.source, 'native');
  assert.equal(second.source, 'native');
  assert.notEqual(String(first._id), String(second._id));
  assert.equal(first.slug, 'react-developer');
  assert.equal(second.slug, 'react-developer'); // same slug, different tenant — allowed
  const jobs = await col('jobs');
  assert.equal(await jobs.countDocuments({ source: 'native' }), 2);
});

// D5(b)
test('two native postings for the SAME company with the same title get distinct slugs', async () => {
  const companyId = new ObjectId();
  const first = await createPostingForCompany(companyId, input(), new ObjectId());
  const second = await createPostingForCompany(companyId, input(), new ObjectId());
  assert.equal(first.slug, 'react-developer');
  assert.equal(second.slug, 'react-developer-2');
});

test('ensureJobIndexes builds the JobID index as unique + partial on sourceSite', async () => {
  const [index, ...rest] = await soleJobIdIndexes();
  assert.equal(rest.length, 0);
  assert.equal(index.name, JOB_ID_UNIQUE_INDEX_NAME);
  assert.equal(index.unique, true);
  assert.deepEqual(index.partialFilterExpression, { sourceSite: { $exists: true } });
});

test('scraped jobs still cannot duplicate a JobID; native postings are unconstrained', async () => {
  const jobs = await col('jobs');
  await jobs.insertOne({ JobID: 'abc-1', sourceSite: 'greenhouse', JobTitle: 'Scraped' });
  await assert.rejects(
    () => jobs.insertOne({ JobID: 'abc-1', sourceSite: 'lever', JobTitle: 'Dup' }),
    (err) => err.code === 11000 && 'JobID' in err.keyPattern,
  );
  // A legacy scraped row missing JobID is still indexed (sourceSite exists) — not hidden.
  await jobs.insertOne({ JobID: null, sourceSite: 'workday', JobTitle: 'Legacy' });
  await assert.rejects(() => jobs.insertOne({ sourceSite: 'ashby', JobTitle: 'Legacy 2' }));
});

// D5(e) — migration script.
test('repair script converts a legacy plain unique index into the partial one', async () => {
  await dropCollections('jobs');
  const jobs = await col('jobs');
  await jobs.createIndex({ JobID: 1 }, { unique: true }); // prod's legacy shape: JobID_1

  const first = await repairJobsJobIdIndex();
  assert.deepEqual(first.dropped, ['JobID_1']);
  assert.equal(first.created, JOB_ID_UNIQUE_INDEX_NAME);

  const [index, ...rest] = await soleJobIdIndexes();
  assert.equal(rest.length, 0, 'legacy index must be gone');
  assert.equal(index.name, JOB_ID_UNIQUE_INDEX_NAME);
  assert.equal(index.unique, true);
  assert.deepEqual(index.partialFilterExpression, { sourceSite: { $exists: true } });

  // And the product bug is actually fixed afterwards.
  await ensurePostingIndexes();
  await createPostingForCompany(new ObjectId(), input(), new ObjectId());
  await createPostingForCompany(new ObjectId(), input(), new ObjectId());
  assert.equal(await jobs.countDocuments({ source: 'native' }), 2);
});

test('repair script is idempotent — a second run reports already correct', async () => {
  await dropCollections('jobs');
  const jobs = await col('jobs');
  await jobs.createIndex({ JobID: 1 }, { unique: true });

  await repairJobsJobIdIndex();
  const second = await repairJobsJobIdIndex();
  assert.equal(second.alreadyCorrect, true);
  assert.deepEqual(second.dropped, []);
  assert.equal(second.created, null);
  assert.equal((await soleJobIdIndexes()).length, 1);
});

test('repair script is a no-op on a fresh collection that only ever had the partial index', async () => {
  const result = await repairJobsJobIdIndex(); // beforeEach already ran ensureJobIndexes
  assert.equal(result.alreadyCorrect, true);
  assert.deepEqual(result.dropped, []);
});

// Pins the reason the migration script is mandatory: MongoDB treats a differing
// partialFilterExpression as a DISTINCT index, so boot adds the new one and
// leaves the legacy unique-on-null index in place, still blocking employers.
test('ensureJobIndexes alone does NOT drop a legacy plain index — repair script must run', async () => {
  await dropCollections('jobs');
  const jobs = await col('jobs');
  await jobs.createIndex({ JobID: 1 }, { unique: true });

  await ensureJobIndexes(); // simulate a deploy + boot, no migration
  const namesAfterBoot = (await soleJobIdIndexes()).map((index) => index.name).sort();
  assert.deepEqual(namesAfterBoot, ['JobID_1', JOB_ID_UNIQUE_INDEX_NAME].sort());

  // Legacy index still enforces uniqueness on JobID:null → employers still blocked.
  await ensurePostingIndexes();
  await createPostingForCompany(new ObjectId(), input(), new ObjectId());
  await assert.rejects(() => createPostingForCompany(new ObjectId(), input(), new ObjectId()));

  // The repair script is what actually unblocks them.
  await repairJobsJobIdIndex();
  assert.deepEqual((await soleJobIdIndexes()).map((index) => index.name), [JOB_ID_UNIQUE_INDEX_NAME]);
  await createPostingForCompany(new ObjectId(), input(), new ObjectId());
  assert.equal(await jobs.countDocuments({ source: 'native' }), 2);
});

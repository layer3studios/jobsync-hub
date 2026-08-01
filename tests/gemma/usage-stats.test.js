// FILE: tests/gemma/usage-stats.test.js
import './../_helpers/test-db.js';
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import { dropCollections, closeTestDb } from '../_helpers/test-db.js';
import { col } from '../../src/Db/connection.js';
import {
  ensureUsageStatsIndexes, recordUsageRequest, recordUsageCacheHit, recordUsageError,
  listUsageStats, istDateString, ERROR_BUCKETS,
} from '../../src/gemma/usage-stats.js';

const IDENTITY = { tier: 'employer', model: 'gemini-3.6-flash', apiKeyIndex: 0 };
const statsCol = () => col('ai_usage_stats');
const today = () => istDateString();

beforeEach(async () => {
  await dropCollections('ai_usage_stats');
  await ensureUsageStatsIndexes();
});
after(async () => { await closeTestDb(); });

test('recording a request upserts one document with the identity fields', async () => {
  await recordUsageRequest(IDENTITY, 1200);
  const docs = await (await statsCol()).find({}).toArray();
  assert.equal(docs.length, 1);
  assert.equal(docs[0].date, today());
  assert.equal(docs[0].tier, 'employer');
  assert.equal(docs[0].model, 'gemini-3.6-flash');
  assert.equal(docs[0].apiKeyIndex, 0);
  assert.equal(docs[0].requests, 1);
  assert.equal(docs[0].tokensEstimated, 1200);
  assert.ok(docs[0].dateExpiry instanceof Date); // TTL anchor
});

test('repeat requests $inc the same document rather than inserting', async () => {
  await recordUsageRequest(IDENTITY, 100);
  await recordUsageRequest(IDENTITY, 250);
  const docs = await (await statsCol()).find({}).toArray();
  assert.equal(docs.length, 1);
  assert.equal(docs[0].requests, 2);
  assert.equal(docs[0].tokensEstimated, 350);
});

test('a cache hit increments cacheHits and NOT requests', async () => {
  await recordUsageCacheHit(IDENTITY);
  const doc = await (await statsCol()).findOne({});
  assert.equal(doc.cacheHits, 1);
  assert.equal(doc.requests, undefined); // never touched
});

test('an error increments only its own bucket', async () => {
  await recordUsageError(IDENTITY, ERROR_BUCKETS.RATE_LIMITED);
  await recordUsageError(IDENTITY, ERROR_BUCKETS.RATE_LIMITED);
  await recordUsageError(IDENTITY, ERROR_BUCKETS.QUOTA_EXHAUSTED);
  const doc = await (await statsCol()).findOne({});
  assert.equal(doc.errors.rate_limited, 2);
  assert.equal(doc.errors.quota_exhausted, 1);
  assert.equal(doc.errors.server_error, undefined);
});

test('an unknown error bucket falls back to `other`', async () => {
  await recordUsageError(IDENTITY, 'something-invented');
  const doc = await (await statsCol()).findOne({});
  assert.equal(doc.errors.other, 1);
});

test('stats are grouped by date + tier + model + keyIndex', async () => {
  await recordUsageRequest({ tier: 'employer', model: 'model-x', apiKeyIndex: 0 }, 10);
  await recordUsageRequest({ tier: 'seeker', model: 'model-x', apiKeyIndex: 0 }, 10);   // tier differs
  await recordUsageRequest({ tier: 'employer', model: 'model-y', apiKeyIndex: 0 }, 10); // model differs
  await recordUsageRequest({ tier: 'employer', model: 'model-x', apiKeyIndex: 1 }, 10); // key differs

  const docs = await (await statsCol()).find({}).toArray();
  assert.equal(docs.length, 4, 'each distinct combo gets its own document');
  for (const doc of docs) assert.equal(doc.requests, 1);
});

test('the unique index rejects a duplicate combo for the same day', async () => {
  await recordUsageRequest(IDENTITY, 10);
  const collection = await statsCol();
  await assert.rejects(() => collection.insertOne({
    date: today(), tier: 'employer', model: 'gemini-3.6-flash', apiKeyIndex: 0, requests: 1,
  }));
});

test('a stats failure never throws into the caller', async () => {
  // A malformed identity would break the update; the writer must swallow it.
  await assert.doesNotReject(() => recordUsageRequest({ tier: 'employer', model: { bad: 'type' } }, 5));
});

test('listUsageStats returns the recent window, oldest first', async () => {
  const collection = await statsCol();
  await collection.insertMany([
    { date: '2000-01-01', tier: 'employer', model: 'old', apiKeyIndex: 0, requests: 1 },
    { date: today(), tier: 'employer', model: 'new', apiKeyIndex: 0, requests: 2 },
  ]);
  const rows = await listUsageStats(7);
  assert.equal(rows.length, 1); // the ancient row is outside the window
  assert.equal(rows[0].model, 'new');
});

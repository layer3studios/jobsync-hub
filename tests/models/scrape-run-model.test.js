// FILE: tests/models/scrape-run-model.test.js
// The scrape_runs write shape, its indexes, and the fire-and-forget guarantee.
import './../_helpers/test-db.js';
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import { dropCollections, closeTestDb, connectTestDb } from '../_helpers/test-db.js';
import { col } from '../../src/Db/connection.js';
import { ensureScrapeRunIndexes, recordScrapeRun, findScrapeRuns, newRunId } from '../../src/models/admin/index.js';

async function reset() {
  await dropCollections('scrape_runs');
  await ensureScrapeRunIndexes();
}

before(reset);
beforeEach(reset);
after(async () => { await closeTestDb(); });

test('ensureScrapeRunIndexes creates the site lookup and the TTL', async () => {
  const db = await connectTestDb();
  const names = (await db.collection('scrape_runs').indexes()).map((i) => i.name);
  assert.ok(names.includes('scrape_runs_site_started'));
  const ttl = (await db.collection('scrape_runs').indexes()).find((i) => i.name === 'scrape_runs_ttl');
  assert.equal(ttl.expireAfterSeconds, 0);
  assert.deepEqual(ttl.key, { startedAtExpiry: 1 });
});

test('recordScrapeRun writes every field and derives durationMs', async () => {
  const runId = newRunId();
  const startedAt = new Date('2026-08-01T10:00:00.000Z');
  const finishedAt = new Date('2026-08-01T10:00:12.500Z');
  await recordScrapeRun({
    runId, siteName: 'greenhouse', startedAt, finishedAt,
    jobsFetched: 120, newJobs: 8, deletedExpired: 3, scrapedSuccessfully: true,
  });

  const doc = await (await col('scrape_runs')).findOne({ runId });
  assert.equal(doc.siteName, 'greenhouse');
  assert.equal(doc.durationMs, 12_500);
  assert.equal(doc.jobsFetched, 120);
  assert.equal(doc.newJobs, 8);
  assert.equal(doc.deletedExpired, 3);
  assert.equal(doc.scrapedSuccessfully, true);
  assert.equal(doc.errorMessage, null);
  assert.ok(doc.startedAt instanceof Date);
  assert.ok(doc.startedAtExpiry instanceof Date);
  // TTL rides a real Date, 90 days out from startedAt.
  assert.equal(doc.startedAtExpiry.getTime() - startedAt.getTime(), 90 * 86_400_000);
});

test('a failed site records scrapedSuccessfully:false with the message', async () => {
  await recordScrapeRun({
    runId: newRunId(), siteName: 'lever', startedAt: new Date(),
    scrapedSuccessfully: false, errorMessage: 'connect ETIMEDOUT',
  });
  const doc = await (await col('scrape_runs')).findOne({ siteName: 'lever' });
  assert.equal(doc.scrapedSuccessfully, false);
  assert.equal(doc.errorMessage, 'connect ETIMEDOUT');
  assert.equal(doc.jobsFetched, 0);   // missing counts default to zero
  assert.equal(doc.newJobs, 0);
});

test('one runId spans every site of a pass', async () => {
  const runId = newRunId();
  for (const siteName of ['greenhouse', 'ashby', 'lever']) {
    await recordScrapeRun({ runId, siteName, startedAt: new Date(), scrapedSuccessfully: true });
  }
  const docs = await (await col('scrape_runs')).find({ runId }).toArray();
  assert.equal(docs.length, 3);
  assert.equal(new Set(docs.map((d) => d.runId)).size, 1);
});

test('an unparseable startedAt falls back to now rather than corrupting the row', async () => {
  const doc = await recordScrapeRun({
    runId: newRunId(), siteName: 'greenhouse', startedAt: 'not-a-date', scrapedSuccessfully: true,
  });
  assert.ok(doc.startedAt instanceof Date && !Number.isNaN(doc.startedAt.getTime()));
  assert.equal(doc.durationMs, 0);
});

test('recordScrapeRun swallows a genuine write failure and resolves to null', async () => {
  // Over BSON's 16MB document ceiling — the insert cannot succeed. The scrape
  // that called this must not see an error.
  const result = await recordScrapeRun({
    runId: newRunId(), siteName: 'greenhouse', startedAt: new Date(),
    errorMessage: 'x'.repeat(17 * 1024 * 1024),
  });
  assert.equal(result, null);
  assert.equal(await (await col('scrape_runs')).countDocuments({ siteName: 'greenhouse' }), 0);
});

test('findScrapeRuns returns newest first and honours the site filter', async () => {
  const base = Date.now();
  await recordScrapeRun({ runId: 'r1', siteName: 'ashby', startedAt: new Date(base - 3000), scrapedSuccessfully: true });
  await recordScrapeRun({ runId: 'r2', siteName: 'ashby', startedAt: new Date(base - 1000), scrapedSuccessfully: true });
  await recordScrapeRun({ runId: 'r3', siteName: 'lever', startedAt: new Date(base - 2000), scrapedSuccessfully: true });

  const all = await findScrapeRuns({ limit: 10 });
  assert.deepEqual(all.map((r) => r.runId), ['r2', 'r3', 'r1']);

  const ashby = await findScrapeRuns({ siteName: 'ashby', limit: 10 });
  assert.deepEqual(ashby.map((r) => r.runId), ['r2', 'r1']);
  assert.ok(!('startedAtExpiry' in ashby[0]), 'the TTL field is not part of the read shape');

  assert.equal((await findScrapeRuns({ limit: 1 })).length, 1);
});

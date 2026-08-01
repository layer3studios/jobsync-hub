// FILE: tests/tasks/scraper-flow.test.js
// The fetch-then-parse split: fetching never depends on AI, and parsing is a
// separate, flag-gated, rate-limit-stoppable phase.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runParsePhase } from '../../src/tasks/scraper-parse-phase.js';

const job = (id) => ({ JobID: id, JobTitle: `Job ${id}`, Description: 'desc' });
const THREE_JOBS = [job('a'), job('b'), job('c')];
const stubClient = { generateContent: async () => '{}' };

test('phase 2 parses every job sequentially, in order', async () => {
  const seen = [];
  const result = await runParsePhase(THREE_JOBS, {
    enabled: true,
    getClient: () => stubClient,
    extractAndStoreRequirements: async (j) => { seen.push(j.JobID); },
  });
  assert.deepEqual(seen, ['a', 'b', 'c']);
  assert.deepEqual(result, { parsed: 3, skipped: 0, failed: 0 });
});

test('phase 2 stops immediately when every model is rate-limited', async () => {
  const seen = [];
  const result = await runParsePhase(THREE_JOBS, {
    enabled: true,
    getClient: () => stubClient,
    extractAndStoreRequirements: async (j) => {
      seen.push(j.JobID);
      if (j.JobID === 'b') throw new Error('[scraper] All models rate-limited. Usage: ...');
    },
  });
  // 'a' parsed, 'b' hit the wall, 'c' never attempted.
  assert.deepEqual(seen, ['a', 'b']);
  assert.equal(result.parsed, 1);
  assert.equal(result.skipped, 2); // b and c
});

test('SCRAPER_JD_EXTRACTION_ENABLED=false skips phase 2 entirely', async () => {
  let called = false;
  const result = await runParsePhase(THREE_JOBS, {
    enabled: false,
    getClient: () => { called = true; return stubClient; },
    extractAndStoreRequirements: async () => { called = true; },
  });
  assert.equal(called, false); // the client is never even resolved
  assert.deepEqual(result, { parsed: 0, skipped: 0, failed: 0 });
});

test('no AI client means nothing is parsed, but nothing throws', async () => {
  const result = await runParsePhase(THREE_JOBS, {
    enabled: true,
    getClient: () => null,
    extractAndStoreRequirements: async () => { throw new Error('should not run'); },
  });
  assert.deepEqual(result, { parsed: 0, skipped: 3, failed: 0 });
});

test('one extraction failure does not stop the loop', async () => {
  const seen = [];
  const result = await runParsePhase(THREE_JOBS, {
    enabled: true,
    getClient: () => stubClient,
    extractAndStoreRequirements: async (j) => {
      seen.push(j.JobID);
      if (j.JobID === 'b') throw new Error('malformed JD');
    },
  });
  assert.deepEqual(seen, ['a', 'b', 'c']); // 'c' still attempted
  assert.equal(result.parsed, 2);
  assert.equal(result.failed, 1);
  assert.equal(result.skipped, 0);
});

test('an empty fetch phase is a no-op', async () => {
  assert.deepEqual(
    await runParsePhase([], { enabled: true, getClient: () => stubClient }),
    { parsed: 0, skipped: 0, failed: 0 },
  );
});

// Phase 1 is verified structurally: runScraper's fetch loop imports no AI
// module, so a quota wall cannot prevent later sites from being scraped.
test('phase 1 (fetch) carries no AI dependency', async () => {
  const source = await import('node:fs').then((fs) =>
    fs.promises.readFile(new URL('../../src/tasks/runScraper.js', import.meta.url), 'utf8'));
  assert.ok(!/gemma-runtime|background-extractor/.test(source), 'fetch phase must not import AI modules');
  // Inside runScraper(), the fetch CALL precedes the parse CALL — so a quota
  // wall in phase 2 cannot prevent any site from being fetched.
  const body = source.slice(source.indexOf('export async function runScraper'));
  assert.ok(body.indexOf('await fetchAllSites') < body.indexOf('await runParsePhase'));
});

// FILE: tests/gemma/env-flags.test.js
// Per-operation kill switches. env.js reads process.env at import time, so
// every flag is set BEFORE the dynamic import of the module under test.
import './../_helpers/test-db.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';

import { dropCollections, closeTestDb } from '../_helpers/test-db.js';

// env.js reads process.env at import time, and static imports are HOISTED —
// so every src module below is loaded with await import(), after these lines.
// Importing `col` statically here would pull env.js in too early and silently
// evaluate the flags as their defaults.
process.env.EMPLOYER_SCORING_ENABLED = 'false';
process.env.EMPLOYER_JD_EXTRACTION_ENABLED = 'false';
process.env.SCRAPER_JD_EXTRACTION_ENABLED = 'false';

const getCol = async (name) => {
  const { col } = await import('../../src/Db/connection.js');
  return col(name);
};

before(async () => { await dropCollections('applications', 'resume_scores', 'jobs'); });
after(async () => { await closeTestDb(); });

test('EMPLOYER_SCORING_ENABLED=false stores a SCORING_DISABLED error', async () => {
  const { scoreApplication } = await import('../../src/services/public/scoring-service.js');
  const companyId = new ObjectId();
  const { insertedId } = await (await getCol('applications')).insertOne({
    companyId, jobId: new ObjectId(), contactId: new ObjectId(), appliedAt: new Date(),
  });

  await scoreApplication(insertedId, {
    // Any of these running would mean the switch failed to short-circuit.
    getResumeFileForApplication: async () => { throw new Error('must not run'); },
    getGemmaClient: () => { throw new Error('must not run'); },
  });

  const score = await (await getCol('resume_scores')).findOne({ applicationId: insertedId });
  assert.equal(score.processingError, 'SCORING_DISABLED');
});

test('EMPLOYER_JD_EXTRACTION_ENABLED=false skips employer JD parsing', async () => {
  const { extractAndStoreRequirements } = await import('../../src/gemma/background-extractor.js');
  const { insertedId } = await (await getCol('jobs')).insertOne({
    source: 'native', title: 'React Dev', description: 'Build things.',
  });
  const jobDoc = { _id: insertedId, source: 'native', title: 'React Dev', description: 'Build things.' };

  // No client is passed and none is resolvable — if the guard were missing this
  // would throw "Gemma is not configured" rather than returning quietly.
  await extractAndStoreRequirements(jobDoc);

  const stored = await (await getCol('jobs')).findOne({ _id: insertedId });
  assert.equal(stored.parsedRequirements, undefined);
});

test('SCRAPER_JD_EXTRACTION_ENABLED=false skips scraped JD parsing', async () => {
  const { extractAndStoreRequirements } = await import('../../src/gemma/background-extractor.js');
  const { insertedId } = await (await getCol('jobs')).insertOne({
    JobID: 's1', JobTitle: 'Scraped Dev', Description: 'Build things.',
  });
  const jobDoc = { _id: insertedId, JobID: 's1', JobTitle: 'Scraped Dev', Description: 'Build things.' };

  await extractAndStoreRequirements(jobDoc);

  const stored = await (await getCol('jobs')).findOne({ _id: insertedId });
  assert.equal(stored.parsedRequirements, undefined);
});

test('SCRAPER_JD_EXTRACTION_ENABLED=false makes getScraperAiClient() null', async () => {
  const runtime = await import('../../src/gemma/gemma-runtime.js');
  runtime.initGemma('key-1,key-2', '');
  assert.equal(runtime.getScraperAiClient(), null);
  // The other tiers are unaffected by the scraper switch.
  assert.notEqual(runtime.getEmployerAiClient(), null);
  assert.notEqual(runtime.getSeekerAiClient(), null);
});

test('BACKWARD COMPAT: keys only (no new env) still builds working tiers', async () => {
  const runtime = await import('../../src/gemma/gemma-runtime.js');
  const result = runtime.initGemma('legacy-key', '');
  assert.equal(result.scoringLiveKeys, 1);
  assert.equal(result.scraperUsesFallback, true); // no scraper pool → shares the main one

  const employer = runtime.getEmployerAiClient();
  assert.ok(employer, 'employer tier must exist with only GEMMA_API_KEYS set');
  // The default cascade is applied, and it still exposes GemmaClient's signature.
  assert.ok(employer.models.length > 1);
  assert.equal(typeof employer.generateContent, 'function');
});

test('no keys at all disables every tier without throwing', async () => {
  const runtime = await import('../../src/gemma/gemma-runtime.js');
  runtime.initGemma('', '');
  assert.equal(runtime.getEmployerAiClient(), null);
  assert.equal(runtime.getSeekerAiClient(), null);
  assert.equal(runtime.getScraperAiClient(), null);
  // Legacy accessors mirror the new ones rather than throwing.
  assert.equal(runtime.getScoringGemmaClient(), null);
  assert.equal(runtime.getGemmaClient(), null);
});

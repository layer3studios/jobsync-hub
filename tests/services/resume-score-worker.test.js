import './../_helpers/test-db.js';
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';

import { dropCollections, closeTestDb, connectTestDb } from '../_helpers/test-db.js';
import { col } from '../../src/Db/connection.js';
import {
  ensureResumeScoreJobIndexes, insertScoreJob, getScoreJobForApplication,
} from '../../src/models/public/resume-score-job-model.js';
import {
  computeSlotCount, pollAndProcess, runSlotIteration,
} from '../../src/services/public/resume-score-worker.js';

const COMPANY = new ObjectId();
const POSTING = new ObjectId();

// Simulate real scoring: scoreApplication swallows failures onto the resume_scores
// row (never throws), so the worker must read the row back to detect failure (Bug A).
const scoreWritingError = (code) => async (appId) => {
  await (await col('resume_scores')).insertOne({ applicationId: appId, companyId: COMPANY, processingError: code });
};

before(async () => { await reset(); });
beforeEach(async () => { await reset(); });
after(async () => { await closeTestDb(); });
async function reset() {
  await dropCollections('resume_score_jobs', 'resume_scores');
  await ensureResumeScoreJobIndexes();
}

test('computeSlotCount: 3 keys → 3, 10 keys → capped at 5, empty → 1', () => {
  assert.equal(computeSlotCount('k1,k2,k3'), 3);
  assert.equal(computeSlotCount('a,b,c,d,e,f,g,h,i,j'), 5);
  assert.equal(computeSlotCount(''), 1);
  assert.equal(computeSlotCount('  ,  '), 1); // blanks ignored, floor of 1
});

test('happy path: pollAndProcess scores the app, marks job done', async () => {
  const appId = new ObjectId();
  await insertScoreJob(appId, COMPANY, POSTING);
  let scoredWith = null;
  const scoreApplication = async (id) => { scoredWith = id; };
  // interpretResult stubbed ok:true — a clean scoring run wrote no processingError.
  const job = await pollAndProcess(0, new Date(), { scoreApplication, interpretResult: async () => ({ ok: true }) });
  assert.equal(scoredWith.toString(), appId.toString());
  assert.equal(job.applicationId.toString(), appId.toString());
  assert.equal((await getScoreJobForApplication(appId)).status, 'done');
});

test('pollAndProcess returns null when the queue is empty', async () => {
  assert.equal(await pollAndProcess(0, new Date(), { scoreApplication: async () => {} }), null);
});

test('failure path: a throwing score requeues the job with future nextTryAt, attemptCount 1', async () => {
  const appId = new ObjectId();
  await insertScoreJob(appId, COMPANY, POSTING);
  const now = new Date();
  const scoreApplication = async () => { throw new Error('gemma 500'); };
  await pollAndProcess(0, now, { scoreApplication });
  const job = await getScoreJobForApplication(appId);
  assert.equal(job.status, 'queued');
  assert.equal(job.attemptCount, 1);
  assert.ok(job.nextTryAt.getTime() > now.getTime());
});

test('backoff schedule: first failure sets nextTryAt ≈ now + 30s (±2s)', async () => {
  const appId = new ObjectId();
  await insertScoreJob(appId, COMPANY, POSTING);
  const now = new Date();
  await pollAndProcess(0, now, { scoreApplication: async () => { throw new Error('x'); } });
  const job = await getScoreJobForApplication(appId);
  const deltaSeconds = (job.nextTryAt.getTime() - now.getTime()) / 1000;
  assert.ok(Math.abs(deltaSeconds - 30) <= 2, `expected ~30s, got ${deltaSeconds}s`);
});

test('terminal failure: reaching MAX_ATTEMPTS marks failed with SCORE_MAX_ATTEMPTS_EXCEEDED', async () => {
  const appId = new ObjectId();
  await insertScoreJob(appId, COMPANY, POSTING);
  // Simulate two prior attempts already consumed; the claim makes this the 3rd.
  const db = await connectTestDb();
  await db.collection('resume_score_jobs').updateOne({ applicationId: appId }, { $set: { attemptCount: 2 } });
  await pollAndProcess(0, new Date(), { scoreApplication: async () => { throw new Error('still down'); } });
  const job = await getScoreJobForApplication(appId);
  assert.equal(job.status, 'failed');
  assert.equal(job.errorCode, 'SCORE_MAX_ATTEMPTS_EXCEEDED');
  assert.equal(job.attemptCount, 3);
});

// ─── Q1-HARDEN: result-based failure detection (Bug A) ──────────────

test('Bug A retryable: scoring returns "ok" but row shows GEMMA_UNAVAILABLE → requeued, not done', async () => {
  const appId = new ObjectId();
  await insertScoreJob(appId, COMPANY, POSTING);
  const now = new Date();
  await pollAndProcess(0, now, { scoreApplication: scoreWritingError('GEMMA_UNAVAILABLE') });
  const job = await getScoreJobForApplication(appId);
  assert.equal(job.status, 'queued'); // requeued, NOT done
  assert.equal(job.attemptCount, 1);
  assert.equal(job.errorCode, 'GEMMA_UNAVAILABLE');
  assert.ok(job.nextTryAt.getTime() > now.getTime());
});

test('Bug A non-retryable: row shows NO_RESUME_FILE → terminal immediately with original code', async () => {
  const appId = new ObjectId();
  await insertScoreJob(appId, COMPANY, POSTING);
  await pollAndProcess(0, new Date(), { scoreApplication: scoreWritingError('NO_RESUME_FILE') });
  const job = await getScoreJobForApplication(appId);
  assert.equal(job.status, 'failed');
  assert.equal(job.errorCode, 'NO_RESUME_FILE'); // NOT SCORE_MAX_ATTEMPTS_EXCEEDED
  assert.equal(job.attemptCount, 1); // failed on first hit, no wasted retries
});

test('Bug A retryable exhausted: 3rd GEMMA_UNAVAILABLE → terminal MAX_ATTEMPTS, underlying preserved', async () => {
  const appId = new ObjectId();
  await insertScoreJob(appId, COMPANY, POSTING);
  const db = await connectTestDb();
  await db.collection('resume_score_jobs').updateOne({ applicationId: appId }, { $set: { attemptCount: 2 } });
  await pollAndProcess(0, new Date(), { scoreApplication: scoreWritingError('GEMMA_UNAVAILABLE') });
  const job = await getScoreJobForApplication(appId);
  assert.equal(job.status, 'failed');
  assert.equal(job.errorCode, 'SCORE_MAX_ATTEMPTS_EXCEEDED');
  assert.match(job.errorMessage, /underlying=GEMMA_UNAVAILABLE/); // R4: cause preserved
});

test('Bug A row missing after scoring → terminal SCORE_ROW_MISSING', async () => {
  const appId = new ObjectId();
  await insertScoreJob(appId, COMPANY, POSTING);
  // scoreApplication writes no row at all (simulated anomaly).
  await pollAndProcess(0, new Date(), { scoreApplication: async () => {} });
  const job = await getScoreJobForApplication(appId);
  assert.equal(job.status, 'failed');
  assert.equal(job.errorCode, 'SCORE_ROW_MISSING');
});

// Gap 1 — a FREE-TEXT processingError (not a stable code) must be retryable.
// scoring-service.js:89-93 stores transient failures as free-text err.message — e.g.
// the literal from scoring-prompt.js:55 below. The denylist treats any non-terminal
// string as retryable. IF TERMINAL_PROCESSING_ERRORS is ever switched back to an
// ALLOWLIST keyed on stable codes, this test FAILS — that is intentional, do not
// delete it (Q1-HARDEN-TESTS V7). It locks the denylist design in place.
test('Bug A design-lock: a free-text processingError is retryable, not terminal', async () => {
  const appId = new ObjectId();
  await insertScoreJob(appId, COMPANY, POSTING);
  const now = new Date();
  const freeText = 'Gemma returned unparseable scoring JSON'; // scoring-prompt.js:55
  await pollAndProcess(0, now, { scoreApplication: scoreWritingError(freeText) });
  const job = await getScoreJobForApplication(appId);
  assert.equal(job.status, 'queued'); // retried, NOT failed — the whole point
  assert.equal(job.attemptCount, 1);
  assert.equal(job.errorCode, freeText);
  assert.ok(job.nextTryAt.getTime() > now.getTime());
});

// Gap 2 — end-to-end retry heals to 'done': fail attempt 1, advance past nextTryAt,
// re-claim, succeed. Proves requeue leaves the job actually re-claimable (R2: a bug
// that set nextTryAt but left lockedUntil would fail here) and the loop self-heals.
test('retry cycle: transient failure then success reaches done on the second attempt', async () => {
  const appId = new ObjectId();
  await insertScoreJob(appId, COMPANY, POSTING);
  let calls = 0;
  const scoreApplication = async (id) => {
    calls += 1;
    const scores = await col('resume_scores');
    const processingError = calls === 1 ? 'Gemma returned unparseable scoring JSON' : null;
    await scores.updateOne(
      { applicationId: id },
      { $set: { applicationId: id, companyId: COMPANY, processingError } },
      { upsert: true },
    );
  };

  const t0 = new Date();
  await pollAndProcess(0, t0, { scoreApplication }); // attempt 1 → requeued at t0+30s
  const afterFirst = await getScoreJobForApplication(appId);
  assert.equal(afterFirst.status, 'queued');
  assert.equal(afterFirst.attemptCount, 1);

  const t1 = new Date(t0.getTime() + 31_000); // advance past the 30s backoff (R3: inject now)
  const claimed = await pollAndProcess(0, t1, { scoreApplication });
  assert.ok(claimed, 'the requeued job must be re-claimable after nextTryAt');

  const healed = await getScoreJobForApplication(appId);
  assert.equal(calls, 2); // scoreApplication ran twice
  assert.equal(healed.status, 'done');
  assert.equal(healed.attemptCount, 2);
  assert.ok(healed.completedAt instanceof Date);
});

// ─── Q1-HARDEN: slot resilience (Bug B) ─────────────────────────────

test('Bug B: a thrown poll error does not kill the slot — it survives and continues', async () => {
  let calls = 0;
  const poll = async () => { calls += 1; if (calls === 1) throw new Error('mongo blip'); return null; };
  const sleepFn = async () => {}; // skip the real 1s backoff
  await runSlotIteration(0, { poll, sleepFn }); // iteration 1: throws, caught
  await runSlotIteration(0, { poll, sleepFn }); // iteration 2: runs anyway
  assert.equal(calls, 2); // slot lived through the throw
});

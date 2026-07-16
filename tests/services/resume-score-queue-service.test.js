import './../_helpers/test-db.js';
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';

import { dropCollections, closeTestDb } from '../_helpers/test-db.js';
import { ensureResumeScoreJobIndexes } from '../../src/models/public/resume-score-job-model.js';
import {
  enqueueScoreJob, enqueueRescoreJob, getScoreJobStatusForApplication,
} from '../../src/services/public/resume-score-queue-service.js';

const COMPANY = new ObjectId();
const POSTING = new ObjectId();

before(async () => { await reset(); });
beforeEach(async () => { await reset(); });
after(async () => { await closeTestDb(); });
async function reset() {
  await dropCollections('resume_score_jobs');
  await ensureResumeScoreJobIndexes();
}

test('enqueueScoreJob happy path creates a queued job and reports enqueued', async () => {
  const appId = new ObjectId();
  const res = await enqueueScoreJob(appId, COMPANY, POSTING);
  assert.equal(res.enqueued, true);
  assert.equal(res.alreadyExisted, false);
  const status = await getScoreJobStatusForApplication(appId);
  assert.equal(status.status, 'queued');
  assert.equal(status.attemptCount, 0);
});

test('enqueueScoreJob is idempotent — second call returns alreadyExisted:true', async () => {
  const appId = new ObjectId();
  const first = await enqueueScoreJob(appId, COMPANY, POSTING);
  const second = await enqueueScoreJob(appId, COMPANY, POSTING);
  assert.equal(second.alreadyExisted, true);
  assert.equal(second.jobId, first.jobId);
});

test('enqueueScoreJob NEVER throws — an invalid applicationId resolves to a null-shape', async () => {
  // insertScoreJob throws on an unresolvable applicationId; the wrapper must swallow it.
  const res = await enqueueScoreJob('not-an-oid', COMPANY, POSTING);
  assert.equal(res.enqueued, false);
  assert.equal(res.jobId, null);
});

test('getScoreJobStatusForApplication returns null when no job exists', async () => {
  assert.equal(await getScoreJobStatusForApplication(new ObjectId()), null);
});

// D12(g)
test('enqueueRescoreJob resets an existing job to queued and reports wasNew:false', async () => {
  const appId = new ObjectId();
  const first = await enqueueScoreJob(appId, COMPANY, POSTING);
  const res = await enqueueRescoreJob(appId, COMPANY, POSTING);
  assert.equal(res.enqueued, true);
  assert.equal(res.wasNew, false);
  assert.equal(res.jobStatus, 'queued');
  assert.equal(res.attemptCount, 0);
  assert.equal(res.jobId, first.jobId, 'same job doc — reset, not duplicated');
});

test('enqueueRescoreJob inserts a job when none exists and reports wasNew:true', async () => {
  const appId = new ObjectId();
  const res = await enqueueRescoreJob(appId, COMPANY, POSTING);
  assert.equal(res.enqueued, true);
  assert.equal(res.wasNew, true);
  assert.equal(res.jobStatus, 'queued');
  assert.equal((await getScoreJobStatusForApplication(appId)).status, 'queued');
});

// D12(h)
test('enqueueRescoreJob NEVER throws — an invalid applicationId resolves to a null-shape', async () => {
  const res = await enqueueRescoreJob('not-an-oid', COMPANY, POSTING);
  assert.equal(res.enqueued, false);
  assert.equal(res.jobId, null);
  assert.equal(res.jobStatus, null);
});

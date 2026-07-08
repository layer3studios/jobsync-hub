import './../_helpers/test-db.js';
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';

import { dropCollections, closeTestDb, connectTestDb } from '../_helpers/test-db.js';
import {
  ensureResumeScoreJobIndexes, insertScoreJob, claimNextScoreJob,
  markScoreJobDone, markScoreJobFailedTerminal, requeueScoreJobWithBackoff,
  resetStuckScoreJobs, getScoreJobForApplication, LOCK_MINUTES,
} from '../../src/models/public/resume-score-job-model.js';

const COMPANY = new ObjectId();
const POSTING = new ObjectId();

before(async () => { await reset(); });
beforeEach(async () => { await reset(); });
after(async () => { await closeTestDb(); });
async function reset() {
  await dropCollections('resume_score_jobs');
  await ensureResumeScoreJobIndexes();
}

const enqueue = (appId = new ObjectId(), now) => insertScoreJob(appId, COMPANY, POSTING, now);

test('insertScoreJob happy path returns jobId + alreadyExisted:false with camelCase job doc', async () => {
  const appId = new ObjectId();
  const res = await insertScoreJob(appId, COMPANY, POSTING);
  assert.equal(res.alreadyExisted, false);
  assert.equal(res.status, 'queued');
  assert.ok(res.jobId);
  const job = await getScoreJobForApplication(appId);
  assert.equal(job.attemptCount, 0);
  assert.equal(job.nextTryAt, null);
  assert.equal(job.companyId.toString(), COMPANY.toString());
  assert.equal(job.postingId.toString(), POSTING.toString());
});

test('insertScoreJob duplicate applicationId returns alreadyExisted:true, no second row', async () => {
  const appId = new ObjectId();
  const first = await insertScoreJob(appId, COMPANY, POSTING);
  const second = await insertScoreJob(appId, COMPANY, POSTING);
  assert.equal(second.alreadyExisted, true);
  assert.equal(second.jobId, first.jobId);
  const db = await connectTestDb();
  assert.equal(await db.collection('resume_score_jobs').countDocuments({ applicationId: appId }), 1);
});

test('ensure creates unique applicationId, pickup, and TTL indexes', async () => {
  const db = await connectTestDb();
  const indexes = await db.collection('resume_score_jobs').indexes();
  const unique = indexes.find((i) => i.name === 'resume_score_jobs_applicationId');
  assert.ok(unique?.unique);
  const ttl = indexes.find((i) => i.name === 'resume_score_jobs_ttl');
  assert.equal(ttl.expireAfterSeconds, 86400);
  assert.ok(indexes.find((i) => i.name === 'resume_score_jobs_pickup'));
});

test('claimNextScoreJob claims a queued job: processing + lockedUntil + attemptCount 1', async () => {
  const appId = new ObjectId();
  await insertScoreJob(appId, COMPANY, POSTING);
  const now = new Date();
  const claimed = await claimNextScoreJob(0, now);
  assert.equal(claimed.status, 'processing');
  assert.equal(claimed.attemptCount, 1);
  assert.ok(claimed.startedAt instanceof Date);
  assert.equal(claimed.lockedUntil.getTime(), now.getTime() + LOCK_MINUTES * 60_000);
});

test('claimNextScoreJob returns null when nothing is queued', async () => {
  assert.equal(await claimNextScoreJob(0, new Date()), null);
});

test('claimNextScoreJob claims oldest first (FIFO by createdAt)', async () => {
  const first = await enqueue(new ObjectId(), new Date(Date.now() - 10_000));
  await enqueue(new ObjectId(), new Date());
  const claimed = await claimNextScoreJob(0, new Date());
  assert.equal(claimed._id.toString(), first.jobId);
});

test('claimNextScoreJob skips jobs whose nextTryAt is in the future', async () => {
  const appId = new ObjectId();
  await insertScoreJob(appId, COMPANY, POSTING);
  const now = new Date();
  await requeueScoreJobWithBackoff((await getScoreJobForApplication(appId))._id, 'X', 'x', 60, now);
  assert.equal(await claimNextScoreJob(0, now), null); // nextTryAt = now+60s
  const later = new Date(now.getTime() + 61_000);
  assert.ok(await claimNextScoreJob(0, later)); // now due
});

test('claimNextScoreJob reclaims a job whose lockedUntil is in the past (stuck)', async () => {
  const appId = new ObjectId();
  await insertScoreJob(appId, COMPANY, POSTING);
  const t0 = new Date(Date.now() - 10 * 60_000);
  const claimed = await claimNextScoreJob(0, t0); // locks until t0+5min (past)
  // Force it back to queued but keep the stale lock, as a stuck row would look.
  const db = await connectTestDb();
  await db.collection('resume_score_jobs').updateOne({ _id: claimed._id }, { $set: { status: 'queued' } });
  const reclaimed = await claimNextScoreJob(1, new Date());
  assert.ok(reclaimed);
  assert.equal(reclaimed.attemptCount, 2);
});

test('resetStuckScoreJobs flips processing→queued for expired locks only', async () => {
  const db = await connectTestDb();
  const jobs = db.collection('resume_score_jobs');
  const stale = await enqueue();
  const fresh = await enqueue();
  const now = new Date();
  await jobs.updateOne({ _id: new ObjectId(stale.jobId) }, { $set: { status: 'processing', lockedUntil: new Date(now.getTime() - 60_000) } });
  await jobs.updateOne({ _id: new ObjectId(fresh.jobId) }, { $set: { status: 'processing', lockedUntil: new Date(now.getTime() + 60_000) } });
  const count = await resetStuckScoreJobs(now);
  assert.equal(count, 1);
  assert.equal((await jobs.findOne({ _id: new ObjectId(stale.jobId) })).status, 'queued');
  assert.equal((await jobs.findOne({ _id: new ObjectId(fresh.jobId) })).status, 'processing');
});

test('markScoreJobDone sets status done + completedAt + clears lock', async () => {
  const appId = new ObjectId();
  await insertScoreJob(appId, COMPANY, POSTING);
  const claimed = await claimNextScoreJob(0, new Date());
  await markScoreJobDone(claimed._id, new Date());
  const job = await getScoreJobForApplication(appId);
  assert.equal(job.status, 'done');
  assert.ok(job.completedAt instanceof Date);
  assert.equal(job.lockedUntil, null);
});

test('markScoreJobFailedTerminal sets status failed + errorCode', async () => {
  const appId = new ObjectId();
  await insertScoreJob(appId, COMPANY, POSTING);
  const claimed = await claimNextScoreJob(0, new Date());
  await markScoreJobFailedTerminal(claimed._id, 'SCORE_MAX_ATTEMPTS_EXCEEDED', 'boom', new Date());
  const job = await getScoreJobForApplication(appId);
  assert.equal(job.status, 'failed');
  assert.equal(job.errorCode, 'SCORE_MAX_ATTEMPTS_EXCEEDED');
  assert.equal(job.errorMessage, 'boom');
});

test('requeueScoreJobWithBackoff sets nextTryAt in the future and clears lockedUntil', async () => {
  const appId = new ObjectId();
  await insertScoreJob(appId, COMPANY, POSTING);
  const claimed = await claimNextScoreJob(0, new Date());
  const now = new Date();
  await requeueScoreJobWithBackoff(claimed._id, 'X', 'x', 30, now);
  const job = await getScoreJobForApplication(appId);
  assert.equal(job.status, 'queued');
  assert.equal(job.lockedUntil, null);
  assert.equal(job.attemptCount, 1); // stays incremented from the claim
  assert.equal(job.nextTryAt.getTime(), now.getTime() + 30_000);
});

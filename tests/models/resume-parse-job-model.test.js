import './../_helpers/test-db.js';
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';

import { dropCollections, closeTestDb, connectTestDb } from '../_helpers/test-db.js';
import {
  ensureResumeParseJobIndexes, insertResumeParseJob, claimNextQueuedJob,
  markJobDone, markJobFailed, resetStuckJobs, getJobForUser, toPublicJob,
} from '../../src/models/seeker/resume-parse-job-model.js';

const USER = new ObjectId();
const OTHER = new ObjectId();

before(async () => { await reset(); });
beforeEach(async () => { await reset(); });
after(async () => { await closeTestDb(); });
async function reset() {
  await dropCollections('resume_parse_jobs');
  await ensureResumeParseJobIndexes();
}

test('insert creates a queued job with camelCase fields and null internals', async () => {
  const job = await insertResumeParseJob({ userId: USER.toString(), source: 'pdf', tmpPath: 'data/tmp/x.pdf', fileHash: 'h1' });
  assert.equal(job.status, 'queued');
  assert.equal(job.source, 'pdf');
  assert.equal(job.tmpPath, 'data/tmp/x.pdf');
  assert.equal(job.result, null);
  assert.ok(job.createdAt instanceof Date);
});

test('ensure creates the three indexes incl. a TTL on completedAt', async () => {
  const db = await connectTestDb();
  const indexes = await db.collection('resume_parse_jobs').indexes();
  const ttl = indexes.find((i) => i.name === 'resume_parse_jobs_ttl');
  assert.ok(ttl);
  assert.equal(ttl.expireAfterSeconds, 86400);
  assert.ok(indexes.find((i) => i.name === 'resume_parse_jobs_pickup'));
});

test('claim flips exactly one queued job to processing, oldest first', async () => {
  const first = await insertResumeParseJob({ userId: USER.toString(), source: 'text', resumeText: 'a', fileHash: 'h1' });
  await insertResumeParseJob({ userId: USER.toString(), source: 'text', resumeText: 'b', fileHash: 'h2' });

  const claimed = await claimNextQueuedJob();
  assert.equal(claimed._id.toString(), first._id.toString()); // FIFO by createdAt
  assert.equal(claimed.status, 'processing');
  assert.ok(claimed.startedAt instanceof Date);

  const second = await claimNextQueuedJob();
  assert.notEqual(second._id.toString(), claimed._id.toString());
  const none = await claimNextQueuedJob();
  assert.equal(none, null); // nothing queued left
});

test('markJobDone / markJobFailed set terminal status + completedAt', async () => {
  const done = await insertResumeParseJob({ userId: USER.toString(), source: 'text', resumeText: 'a', fileHash: 'h1' });
  await markJobDone(done._id, { profile: { fullName: 'Asha' }, isUnchanged: false });
  const doneJob = await getJobForUser(USER.toString(), done._id.toString());
  assert.equal(doneJob.status, 'done');
  assert.equal(doneJob.result.profile.fullName, 'Asha');
  assert.ok(doneJob.completedAt instanceof Date);

  const failed = await insertResumeParseJob({ userId: USER.toString(), source: 'text', resumeText: 'b', fileHash: 'h2' });
  await markJobFailed(failed._id, 'GEMMA_UNAVAILABLE', 'down');
  const failedJob = await getJobForUser(USER.toString(), failed._id.toString());
  assert.equal(failedJob.status, 'failed');
  assert.equal(failedJob.errorCode, 'GEMMA_UNAVAILABLE');
});

test('resetStuckJobs requeues processing rows older than 1 min, leaves fresh ones', async () => {
  const db = await connectTestDb();
  const col = db.collection('resume_parse_jobs');
  const stale = await insertResumeParseJob({ userId: USER.toString(), source: 'pdf', tmpPath: 't', fileHash: 'h1' });
  const fresh = await insertResumeParseJob({ userId: USER.toString(), source: 'pdf', tmpPath: 't', fileHash: 'h2' });
  const now = new Date();
  await col.updateOne({ _id: stale._id }, { $set: { status: 'processing', startedAt: new Date(now.getTime() - 2 * 60 * 1000) } });
  await col.updateOne({ _id: fresh._id }, { $set: { status: 'processing', startedAt: now } });

  const requeued = await resetStuckJobs(60 * 1000, now);
  assert.equal(requeued, 1);
  assert.equal((await getJobForUser(USER.toString(), stale._id.toString())).status, 'queued');
  assert.equal((await getJobForUser(USER.toString(), fresh._id.toString())).status, 'processing');
});

test('getJobForUser is owner-scoped; toPublicJob drops tmpPath + resumeText', async () => {
  const job = await insertResumeParseJob({ userId: USER.toString(), source: 'text', resumeText: 'secret', fileHash: 'h1' });
  assert.equal(await getJobForUser(OTHER.toString(), job._id.toString()), null);

  const stored = await getJobForUser(USER.toString(), job._id.toString());
  const shape = toPublicJob(stored);
  assert.equal(shape.id, job._id.toString());
  assert.equal('tmpPath' in shape, false);
  assert.equal('resumeText' in shape, false);
});

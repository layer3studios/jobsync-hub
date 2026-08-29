// FILE: src/models/admin/indexing-job-model.js
// indexing_jobs collection — the Google Indexing API submission queue, cloned in
// shape from resume-score-job-model (atomic claim, attempt counting, TTL).
//
// NATIVE POSTINGS ONLY. Google restricts the Indexing API to pages you own and
// caps it at 200 URLs/day; a scraped job's URL belongs to someone else's ATS.
// The service enforces that — this model only ever sees native postings.
//
// Retention rides `completedAtExpiry`, the same real-Date TTL technique used by
// scrape-run-model and email-event-model.

import { ObjectId } from 'mongodb';
import { col } from '../../Db/connection.js';

const COLLECTION = 'indexing_jobs';
const RETENTION_DAYS = 90;
const MS_PER_DAY = 86_400_000;

export const INDEXING_ACTIONS = Object.freeze({
  UPDATED: 'URL_UPDATED',
  DELETED: 'URL_DELETED',
});

export const INDEXING_STATUS = Object.freeze({
  QUEUED: 'queued',
  PROCESSING: 'processing',
  DONE: 'done',
  FAILED: 'failed',
});

/** Google's documented daily cap for the Indexing API. */
export const DAILY_QUOTA = 200;
export const MAX_ATTEMPTS = 3;

const jobsCol = () => col(COLLECTION);

function toOid(id) {
  if (id instanceof ObjectId) return id;
  if (typeof id === 'string' && ObjectId.isValid(id)) return new ObjectId(id);
  return null;
}

/** Idempotent index setup. Called from server boot. */
export async function ensureIndexingJobIndexes() {
  const collection = await jobsCol();
  await collection.createIndex({ status: 1, createdAt: 1 }, { name: 'indexing_jobs_pickup' });
  await collection.createIndex({ postingId: 1, createdAt: -1 }, { name: 'indexing_jobs_posting' });
  await collection.createIndex(
    { completedAtExpiry: 1 },
    { expireAfterSeconds: 0, name: 'indexing_jobs_ttl' },
  );
}

/**
 * Queue one submission. Upserts on (postingId, action, status: queued) so a double
 * publish, or a publish followed by an edit before the worker runs, collapses into
 * one pending job rather than spending two of the day's 200 calls on one URL.
 */
export async function enqueueIndexingJob({ postingId, url, action } = {}) {
  if (!url || !Object.values(INDEXING_ACTIONS).includes(action)) {
    return { enqueued: false, reason: 'invalid_job' };
  }
  const oid = toOid(postingId);
  if (!oid) return { enqueued: false, reason: 'invalid_posting_id' };

  const now = new Date();
  const collection = await jobsCol();
  const result = await collection.updateOne(
    { postingId: oid, action, status: INDEXING_STATUS.QUEUED },
    {
      // url is $set so a slug edit before the worker runs submits the NEW url.
      $set: { url, updatedAt: now },
      $setOnInsert: {
        postingId: oid, action, status: INDEXING_STATUS.QUEUED,
        attemptCount: 0, lastError: null, createdAt: now, completedAt: null,
      },
    },
    { upsert: true },
  );
  return { enqueued: true, created: result.upsertedCount > 0 };
}

/** Atomically claim the oldest queued job. Returns it, or null when idle. */
export async function claimNextIndexingJob(now = new Date()) {
  const collection = await jobsCol();
  return collection.findOneAndUpdate(
    { status: INDEXING_STATUS.QUEUED },
    { $set: { status: INDEXING_STATUS.PROCESSING, startedAt: now }, $inc: { attemptCount: 1 } },
    { sort: { createdAt: 1 }, returnDocument: 'after' },
  );
}

const expiryFor = (now) => new Date(now.getTime() + RETENTION_DAYS * MS_PER_DAY);

export async function markIndexingJobDone(jobId, now = new Date()) {
  await (await jobsCol()).updateOne(
    { _id: toOid(jobId) },
    {
      $set: {
        status: INDEXING_STATUS.DONE, lastError: null,
        completedAt: now, completedAtExpiry: expiryFor(now),
      },
    },
  );
}

/** Back to queued for another attempt, or terminally failed once out of attempts. */
export async function markIndexingJobFailed(jobId, errorMessage, { retry }, now = new Date()) {
  const terminal = !retry;
  await (await jobsCol()).updateOne(
    { _id: toOid(jobId) },
    {
      $set: {
        status: terminal ? INDEXING_STATUS.FAILED : INDEXING_STATUS.QUEUED,
        lastError: String(errorMessage ?? ''),
        ...(terminal ? { completedAt: now, completedAtExpiry: expiryFor(now) } : {}),
      },
    },
  );
}

/**
 * Put a claimed job back in the queue WITHOUT consuming an attempt — used for a
 * 429, where the failure is our quota, not this job.
 */
export async function releaseIndexingJob(jobId, errorMessage) {
  await (await jobsCol()).updateOne(
    { _id: toOid(jobId) },
    {
      $set: { status: INDEXING_STATUS.QUEUED, lastError: String(errorMessage ?? '') },
      $inc: { attemptCount: -1 },
    },
  );
}

/** Requeue a terminally failed job, resetting its attempts. Admin retry action. */
export async function requeueIndexingJob(jobId) {
  const oid = toOid(jobId);
  if (!oid) return { ok: false, reason: 'invalid_job_id' };
  const result = await (await jobsCol()).updateOne(
    { _id: oid, status: INDEXING_STATUS.FAILED },
    {
      $set: {
        status: INDEXING_STATUS.QUEUED, attemptCount: 0,
        lastError: null, completedAt: null,
      },
      $unset: { completedAtExpiry: '' },
    },
  );
  return result.matchedCount === 0
    ? { ok: false, reason: 'not_found_or_not_failed' }
    : { ok: true };
}

/** Stuck 'processing' rows from a crashed worker, back to queued. */
export async function resetStuckIndexingJobs(maxAgeMs = 5 * 60_000, now = new Date()) {
  const result = await (await jobsCol()).updateMany(
    { status: INDEXING_STATUS.PROCESSING, startedAt: { $lt: new Date(now.getTime() - maxAgeMs) } },
    { $set: { status: INDEXING_STATUS.QUEUED } },
  );
  return result.modifiedCount;
}

export async function countIndexingByStatus() {
  const rows = await (await jobsCol()).aggregate([
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]).toArray();
  const counts = Object.fromEntries(Object.values(INDEXING_STATUS).map((s) => [s, 0]));
  for (const row of rows) counts[row._id ?? 'unknown'] = row.count;
  return counts;
}

/** Successful submissions since midnight — what the 200/day quota is spent on. */
export async function countSubmissionsToday(now = new Date()) {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  return (await jobsCol()).countDocuments({
    status: INDEXING_STATUS.DONE, completedAt: { $gte: midnight },
  });
}

export async function listRecentFailures(limit = 10) {
  return (await jobsCol())
    .find({ status: INDEXING_STATUS.FAILED }, { projection: { completedAtExpiry: 0 } })
    .sort({ completedAt: -1 }).limit(limit).toArray();
}

/** Posting ids with a completed URL_DELETED — used to find the ones without one. */
export async function findDeletedPostingIds(postingIds = []) {
  const oids = postingIds.map(toOid).filter(Boolean);
  if (oids.length === 0) return new Set();
  const rows = await (await jobsCol()).find(
    { postingId: { $in: oids }, action: INDEXING_ACTIONS.DELETED, status: INDEXING_STATUS.DONE },
    { projection: { postingId: 1 } },
  ).toArray();
  return new Set(rows.map((row) => row.postingId.toString()));
}

export default enqueueIndexingJob;

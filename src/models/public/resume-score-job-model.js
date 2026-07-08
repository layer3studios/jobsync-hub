// FILE: src/models/public/resume-score-job-model.js
// resume_score_jobs collection (Q1 D1) — the Mongo-backed applicant-scoring queue,
// mirroring the F1 resume_parse_jobs pattern. Job pickup is atomic (R1):
// claimNextScoreJob flips one ready 'queued' row to 'processing' in a single
// findOneAndUpdate, so concurrent worker slots never grab the same job. Every job
// carries companyId + postingId so the worker stays multi-tenant safe without
// ambient context (C8). Completed rows self-delete after 24h via a TTL index.

import { ObjectId } from 'mongodb';
import { col } from '../../Db/connection.js';

const jobsCol = () => col('resume_score_jobs');

// The lock a claim holds; also the stuck-recovery cutoff. Single source of truth so
// the model's claim and the worker's boot recovery can never drift (Q1 D2).
export const LOCK_MINUTES = 5;

// No magic strings for status (C2). Queue lifecycle only — scoring outcome lives on
// resume_scores.processingError, a separate axis (Q1 D8).
export const SCORE_JOB_STATUS = Object.freeze({
  QUEUED: 'queued',
  PROCESSING: 'processing',
  DONE: 'done',
  FAILED: 'failed',
});

// Error codes the queue itself emits (Q1 D8); underlying scoring keeps its own.
export const SCORE_JOB_ERROR = Object.freeze({
  MAX_ATTEMPTS_EXCEEDED: 'SCORE_MAX_ATTEMPTS_EXCEEDED',
  UNKNOWN: 'SCORE_UNKNOWN_ERROR',
});

function toOid(id) {
  if (id instanceof ObjectId) return id;
  if (typeof id === 'string' && ObjectId.isValid(id)) return new ObjectId(id);
  return null;
}

/** Idempotent index setup. Called on boot. */
export async function ensureResumeScoreJobIndexes() {
  const collection = await jobsCol();
  await collection.createIndex({ applicationId: 1 }, { unique: true, name: 'resume_score_jobs_applicationId' });
  await collection.createIndex({ status: 1, nextTryAt: 1 }, { name: 'resume_score_jobs_pickup' });
  await collection.createIndex({ completedAt: 1 }, { name: 'resume_score_jobs_ttl', expireAfterSeconds: 86400 });
}

/**
 * Insert a queued job for one application (unique per applicationId, R5). On a
 * duplicate-key collision returns the existing job's id with alreadyExisted: true
 * rather than throwing — enqueue is idempotent.
 */
export async function insertScoreJob(applicationId, companyId, postingId, now = new Date()) {
  const appOid = toOid(applicationId);
  if (!appOid) throw new Error('insertScoreJob: invalid applicationId');
  const doc = {
    applicationId: appOid,
    companyId: toOid(companyId),
    postingId: toOid(postingId),
    status: SCORE_JOB_STATUS.QUEUED,
    errorCode: null,
    errorMessage: null,
    attemptCount: 0,
    nextTryAt: null,
    lockedUntil: null,
    createdAt: now,
    startedAt: null,
    completedAt: null,
  };
  const collection = await jobsCol();
  try {
    const { insertedId } = await collection.insertOne(doc);
    return { jobId: insertedId.toString(), status: doc.status, alreadyExisted: false };
  } catch (err) {
    if (err?.code === 11000) {
      const existing = await collection.findOne({ applicationId: appOid });
      return { jobId: existing?._id?.toString() ?? null, status: existing?.status ?? null, alreadyExisted: true };
    }
    throw err;
  }
}

/**
 * Atomically claim the oldest ready queued job (R1): status queued, nextTryAt due,
 * and either unlocked or its lock expired. Flips it to processing, stamps the lock,
 * and increments attemptCount. Returns the claimed doc or null. slotIndex is for the
 * caller's logging only — first free slot wins, no key ownership (R3).
 */
export async function claimNextScoreJob(slotIndex, now = new Date()) {
  const collection = await jobsCol();
  const lockedUntil = new Date(now.getTime() + LOCK_MINUTES * 60_000);
  return collection.findOneAndUpdate(
    {
      status: SCORE_JOB_STATUS.QUEUED,
      // Two independent $or clauses cannot share one object key (F3b H1); AND them.
      $and: [
        { $or: [{ nextTryAt: null }, { nextTryAt: { $lte: now } }] },
        { $or: [{ lockedUntil: null }, { lockedUntil: { $lte: now } }] },
      ],
    },
    {
      $set: { status: SCORE_JOB_STATUS.PROCESSING, startedAt: now, lockedUntil },
      $inc: { attemptCount: 1 },
    },
    { sort: { createdAt: 1 }, returnDocument: 'after' },
  );
}

/** Mark a claimed job done. */
export async function markScoreJobDone(jobId, now = new Date()) {
  const collection = await jobsCol();
  await collection.updateOne(
    { _id: toOid(jobId) },
    { $set: { status: SCORE_JOB_STATUS.DONE, errorCode: null, errorMessage: null, lockedUntil: null, completedAt: now } },
  );
}

/** Mark a claimed job permanently failed with a stable code (after MAX_ATTEMPTS). */
export async function markScoreJobFailedTerminal(jobId, errorCode, errorMessage, now = new Date()) {
  const collection = await jobsCol();
  await collection.updateOne(
    { _id: toOid(jobId) },
    {
      $set: {
        status: SCORE_JOB_STATUS.FAILED,
        errorCode,
        errorMessage: String(errorMessage ?? ''),
        lockedUntil: null,
        completedAt: now,
      },
    },
  );
}

/**
 * Requeue a failed-but-retryable job with backoff: status back to queued, nextTryAt
 * pushed out, lock cleared. attemptCount stays incremented from the claim (Q1 D2).
 */
export async function requeueScoreJobWithBackoff(jobId, errorCode, errorMessage, backoffSeconds, now = new Date()) {
  const collection = await jobsCol();
  await collection.updateOne(
    { _id: toOid(jobId) },
    {
      $set: {
        status: SCORE_JOB_STATUS.QUEUED,
        errorCode,
        errorMessage: String(errorMessage ?? ''),
        nextTryAt: new Date(now.getTime() + backoffSeconds * 1000),
        lockedUntil: null,
        startedAt: null,
      },
    },
  );
}

/** Requeue jobs stuck in 'processing' past their lock — a worker slot crashed (F1). */
export async function resetStuckScoreJobs(now = new Date()) {
  const collection = await jobsCol();
  const result = await collection.updateMany(
    { status: SCORE_JOB_STATUS.PROCESSING, lockedUntil: { $lt: now } },
    { $set: { status: SCORE_JOB_STATUS.QUEUED, lockedUntil: null, startedAt: null } },
  );
  return result.modifiedCount;
}

/** Fetch the job for one application, or null. Read side for the queue service. */
export async function getScoreJobForApplication(applicationId) {
  const oid = toOid(applicationId);
  if (!oid) return null;
  const collection = await jobsCol();
  return collection.findOne({ applicationId: oid });
}

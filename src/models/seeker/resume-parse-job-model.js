// FILE: src/models/seeker/resume-parse-job-model.js
// resume_parse_jobs collection (D1) — the Mongo-backed async parse queue. Every read
// is userId-scoped (§6.5). Job pickup is atomic (R3): claimNextQueuedJob flips one
// 'queued' row to 'processing' in a single findOneAndUpdate, so concurrent workers
// never grab the same job. Completed/failed rows self-delete after 24h via a TTL
// index on completedAt (R5). tmpPath/resumeText are internal — toPublicJob drops them.

import { ObjectId } from 'mongodb';
import { col } from '../../Db/connection.js';

const jobsCol = () => col('resume_parse_jobs');

function toOid(id) {
  if (id instanceof ObjectId) return id;
  if (typeof id === 'string' && ObjectId.isValid(id)) return new ObjectId(id);
  return null;
}

/** Idempotent index setup. Called on boot. */
export async function ensureResumeParseJobIndexes() {
  const collection = await jobsCol();
  await collection.createIndex({ userId: 1, createdAt: -1 }, { name: 'resume_parse_jobs_user' });
  await collection.createIndex({ status: 1, createdAt: 1 }, { name: 'resume_parse_jobs_pickup' });
  await collection.createIndex({ completedAt: 1 }, { name: 'resume_parse_jobs_ttl', expireAfterSeconds: 86400 });
}

/** Insert a queued job. source 'pdf' carries tmpPath; source 'text' carries resumeText. */
export async function insertResumeParseJob({ userId, source, tmpPath = null, resumeText = null, fileHash }) {
  const now = new Date();
  const doc = {
    userId: toOid(userId), source, tmpPath, resumeText, fileHash,
    status: 'queued', result: null, errorCode: null, errorMessage: null,
    createdAt: now, updatedAt: now, startedAt: null, completedAt: null,
  };
  const collection = await jobsCol();
  const { insertedId } = await collection.insertOne(doc);
  return { ...doc, _id: insertedId };
}

/** Atomically claim the oldest queued job, flipping it to 'processing'. Returns it or null. */
export async function claimNextQueuedJob(now = new Date()) {
  const collection = await jobsCol();
  return collection.findOneAndUpdate(
    { status: 'queued' },
    { $set: { status: 'processing', startedAt: now, updatedAt: now } },
    { sort: { createdAt: 1 }, returnDocument: 'after' },
  );
}

/** Mark a claimed job done with its result payload. */
export async function markJobDone(jobId, result, now = new Date()) {
  const collection = await jobsCol();
  await collection.updateOne(
    { _id: toOid(jobId) },
    { $set: { status: 'done', result, errorCode: null, errorMessage: null, updatedAt: now, completedAt: now } },
  );
}

/** Mark a claimed job failed with a stable code + message. */
export async function markJobFailed(jobId, errorCode, errorMessage, now = new Date()) {
  const collection = await jobsCol();
  await collection.updateOne(
    { _id: toOid(jobId) },
    { $set: { status: 'failed', errorCode, errorMessage: String(errorMessage ?? ''), updatedAt: now, completedAt: now } },
  );
}

/** Requeue jobs stuck in 'processing' past maxAgeMs — a worker crashed mid-job (R4). */
export async function resetStuckJobs(maxAgeMs = 60 * 1000, now = new Date()) {
  const collection = await jobsCol();
  const cutoff = new Date(now.getTime() - maxAgeMs);
  const result = await collection.updateMany(
    { status: 'processing', startedAt: { $lt: cutoff } },
    { $set: { status: 'queued', startedAt: null, updatedAt: now } },
  );
  return result.modifiedCount;
}

/** Fetch one job scoped to its owner (§6.5). Returns null on mismatch or bad ids. */
export async function getJobForUser(userId, jobId) {
  const userOid = toOid(userId);
  const jobOid = toOid(jobId);
  if (!userOid || !jobOid) return null;
  const collection = await jobsCol();
  return collection.findOne({ _id: jobOid, userId: userOid });
}

/** Client-safe projection — never leaks tmpPath or resumeText. */
export function toPublicJob(doc) {
  if (!doc) return null;
  return {
    id: doc._id.toString(),
    status: doc.status,
    result: doc.result ?? null,
    errorCode: doc.errorCode ?? null,
    errorMessage: doc.errorMessage ?? null,
    createdAt: doc.createdAt ?? null,
    completedAt: doc.completedAt ?? null,
  };
}

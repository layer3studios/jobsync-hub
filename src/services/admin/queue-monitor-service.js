// FILE: src/services/admin/queue-monitor-service.js
// Reads for the admin Queue Monitor, over the three Mongo-backed worker queues.
// Everything the queues differ on — collection, status vocabulary, timestamp and
// error fields — lives in the QUEUES registry, so the three code paths below stay
// identical. Every value here was read off the job models, never assumed.
//
// PRIVACY: the failed-job projection carries an id, timestamps, the error message
// and ONE identifying id. Never resumeText, tmpPath, or file contents.
//
// This service performs exactly one write: retryFailedJob, whose per-queue reset
// mirrors that queue's own recovery path (see `retryReset` on each entry).

import { ObjectId } from 'mongodb';
import { col } from '../../Db/connection.js';

/**
 * `dueFilter` narrows "pending" to jobs actually waiting on a worker rather than
 * on the clock: a score job in backoff or a reminder scheduled for tomorrow is
 * idle by design, and counting its age would report a permanent false stall.
 */
export const QUEUES = Object.freeze({
  'resume-parse': {
    key: 'resume-parse',
    label: 'Resume parsing',
    collection: 'resume_parse_jobs',
    statuses: ['queued', 'processing', 'done', 'failed'],
    pendingStatus: 'queued',
    processingStatus: 'processing',
    doneStatus: 'done',
    failedStatus: 'failed',
    errorField: 'errorMessage',
    identityField: 'userId',
    pendingAgeField: 'createdAt',
    dueFilter: () => ({}),
    // resetStuckJobs sets status/startedAt/updatedAt; a failed row additionally
    // carries the markJobFailed fields, and its completedAt drives the 24h TTL —
    // left set, a retried job would be reaped mid-flight.
    retryReset: (now) => ({
      status: 'queued', startedAt: null, updatedAt: now,
      errorCode: null, errorMessage: null, completedAt: null,
    }),
  },
  'resume-score': {
    key: 'resume-score',
    label: 'Applicant scoring',
    collection: 'resume_score_jobs',
    statuses: ['queued', 'processing', 'done', 'failed'],
    pendingStatus: 'queued',
    processingStatus: 'processing',
    doneStatus: 'done',
    failedStatus: 'failed',
    errorField: 'errorMessage',
    identityField: 'applicationId',
    pendingAgeField: 'createdAt',
    dueFilter: (now) => ({ $or: [{ nextTryAt: null }, { nextTryAt: { $lte: now } }] }),
    // The model's own RESCORE_RESET_FIELDS — "a job returns to exactly its
    // freshly-inserted state". attemptCount MUST go back to 0: a terminal failure
    // is usually MAX_ATTEMPTS_EXCEEDED, and a retry that left it at 3 would be
    // failed again on its first claim.
    retryReset: () => ({
      status: 'queued', errorCode: null, errorMessage: null, attemptCount: 0,
      nextTryAt: null, lockedUntil: null, startedAt: null, completedAt: null,
    }),
  },
  'interview-reminder': {
    key: 'interview-reminder',
    label: 'Interview reminders',
    collection: 'interview_reminder_jobs',
    statuses: ['pending', 'claimed', 'completed', 'failed', 'cancelled'],
    pendingStatus: 'pending',
    processingStatus: 'claimed',
    doneStatus: 'completed',
    failedStatus: 'failed',
    errorField: 'lastError',
    identityField: 'interviewId',
    // A reminder is late relative to its send time, not its creation time.
    pendingAgeField: 'sendAtUtc',
    dueFilter: (now) => ({ sendAtUtc: { $lte: now } }),
    // This queue has no stuck-recovery sweep; its reset-to-pending is the
    // reschedule path in scheduleInterviewReminders. sendAtUtc is deliberately
    // NOT touched: it is already past, so the job is immediately claimable.
    retryReset: (now) => ({
      status: 'pending', attemptCount: 0, claimedAt: null,
      completedAt: null, lastError: null, updatedAt: now,
    }),
  },
});

export const isKnownQueue = (queueKey) => Object.hasOwn(QUEUES, queueKey);

function toOid(id) {
  if (id instanceof ObjectId) return id;
  if (typeof id === 'string' && ObjectId.isValid(id)) return new ObjectId(id);
  return null;
}

/** Zero-filled so every status shows even with no rows in it. */
function emptyCounts(queue) {
  return Object.fromEntries(queue.statuses.map((status) => [status, 0]));
}

/** One queue's card: counts per status, oldest due pending, failures, last success. */
async function summariseQueue(queue, now) {
  const collection = await col(queue.collection);

  const grouped = await collection.aggregate([
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]).toArray();

  const counts = emptyCounts(queue);
  let total = 0;
  for (const row of grouped) {
    // An unrecognised status is surfaced rather than silently dropped.
    counts[row._id ?? 'unknown'] = (counts[row._id ?? 'unknown'] ?? 0) + row.count;
    total += row.count;
  }

  const [oldestPending] = await collection
    .find(
      { status: queue.pendingStatus, ...queue.dueFilter(now) },
      { projection: { [queue.pendingAgeField]: 1 } },
    )
    .sort({ [queue.pendingAgeField]: 1 })
    .limit(1)
    .toArray();

  const oldestPendingAt = oldestPending?.[queue.pendingAgeField] ?? null;
  const oldestPendingAgeMs = oldestPendingAt instanceof Date
    ? Math.max(0, now.getTime() - oldestPendingAt.getTime())
    : null;

  const [lastCompleted] = await collection
    .find({ status: queue.doneStatus, completedAt: { $ne: null } }, { projection: { completedAt: 1 } })
    .sort({ completedAt: -1 })
    .limit(1)
    .toArray();

  return {
    key: queue.key,
    label: queue.label,
    collection: queue.collection,
    counts,
    totalJobs: total,
    pendingStatus: queue.pendingStatus,
    processingStatus: queue.processingStatus,
    failedStatus: queue.failedStatus,
    identityField: queue.identityField,
    oldestPendingAgeMs,
    failedCount: counts[queue.failedStatus] ?? 0,
    lastCompletedAt: lastCompleted?.completedAt ?? null,
  };
}

/** Every queue's card, in registry order. */
export async function getQueueOverview(now = new Date()) {
  const queues = [];
  for (const queue of Object.values(QUEUES)) {
    queues.push(await summariseQueue(queue, now));
  }
  return queues;
}

/** Newest failures first. The projection is deliberately narrow — see PRIVACY. */
export async function listFailedJobs(queueKey, limit = 25) {
  const queue = QUEUES[queueKey];
  if (!queue) return [];
  const collection = await col(queue.collection);
  const docs = await collection
    .find(
      { status: queue.failedStatus },
      {
        projection: {
          createdAt: 1, completedAt: 1, updatedAt: 1, attemptCount: 1,
          [queue.errorField]: 1, [queue.identityField]: 1,
        },
      },
    )
    .sort({ completedAt: -1 })
    .limit(limit)
    .toArray();

  return docs.map((doc) => ({
    id: doc._id.toString(),
    identityLabel: queue.identityField,
    identityValue: doc[queue.identityField] != null ? String(doc[queue.identityField]) : null,
    errorMessage: doc[queue.errorField] ?? null,
    attemptCount: doc.attemptCount ?? null,
    createdAt: doc.createdAt ?? null,
    failedAt: doc.completedAt ?? doc.updatedAt ?? null,
  }));
}

/**
 * Reset ONE failed job to pending, exactly as its queue's own recovery does.
 * Scoped to `status: failed` so this can never disturb a job a worker is holding.
 */
export async function retryFailedJob(queueKey, jobId, now = new Date()) {
  const queue = QUEUES[queueKey];
  if (!queue) return { retried: false, reason: 'unknown_queue' };
  const oid = toOid(jobId);
  if (!oid) return { retried: false, reason: 'invalid_job_id' };

  const collection = await col(queue.collection);
  const result = await collection.updateOne(
    { _id: oid, status: queue.failedStatus },
    { $set: queue.retryReset(now) },
  );
  if (result.matchedCount === 0) return { retried: false, reason: 'not_found_or_not_failed' };
  return { retried: true, queueKey, jobId: oid.toString() };
}

export default getQueueOverview;

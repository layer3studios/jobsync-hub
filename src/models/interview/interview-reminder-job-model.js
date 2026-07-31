// FILE: src/models/interview/interview-reminder-job-model.js
// interview_reminder_jobs collection — Mongo-backed 24h reminder queue,
// mirroring resume-score-job-model: atomic claim via findOneAndUpdate, backoff
// by pushing sendAtUtc out, TTL cleanup on completedAt. NO scheduler library.
//
// THE UNIQUE (interviewId, recipientKind) INDEX IS THE IDEMPOTENCY GUARANTEE:
// a reschedule, retry, or duplicate booking attempt upserts into the SAME row —
// moving the existing reminder, never adding a second. Nothing in this feature
// can send the same person the same reminder twice.

import { ObjectId } from 'mongodb';
import { col } from '../../Db/connection.js';

const jobsCol = () => col('interview_reminder_jobs');

export const REMINDER_JOB_STATUS = Object.freeze({
  PENDING: 'pending',
  CLAIMED: 'claimed',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
});

export const REMINDER_RECIPIENT_KINDS = Object.freeze({
  CANDIDATE: 'candidate',
  INTERVIEWER: 'interviewer',
});

export const REMINDER_LEAD_HOURS = 24;
const MILLISECONDS_PER_HOUR = 60 * 60 * 1000;
const COMPLETED_TTL_SECONDS = 86400; // matches the existing job models' retention

function toOid(id) {
  if (id instanceof ObjectId) return id;
  if (typeof id === 'string' && ObjectId.isValid(id)) return new ObjectId(id);
  return null;
}

/** Idempotent index setup. Called on boot. */
export async function ensureInterviewReminderJobIndexes() {
  const collection = await jobsCol();
  await collection.createIndex(
    { interviewId: 1, recipientKind: 1 },
    { unique: true, name: 'interview_reminder_jobs_interviewId_recipientKind' },
  );
  await collection.createIndex({ status: 1, sendAtUtc: 1 }, { name: 'interview_reminder_jobs_status_sendAtUtc' });
  await collection.createIndex({ completedAt: 1 }, { name: 'interview_reminder_jobs_ttl', expireAfterSeconds: COMPLETED_TTL_SECONDS });
}

/**
 * Upsert one candidate + one interviewer reminder at startAtUtc − 24h. A
 * reschedule reuses the same rows (unique index), resetting them to pending
 * with the new sendAtUtc. When the reminder instant is already past (a booking
 * made inside 24 hours — allowed), nothing is scheduled at all: an immediate
 * reminder on top of the confirmation email would be noise.
 */
export async function scheduleInterviewReminders(interview, now = new Date()) {
  if (!interview?.startAtUtc) return { scheduled: false, reason: 'NO_START_TIME' };
  const sendAtUtc = new Date(interview.startAtUtc.getTime() - REMINDER_LEAD_HOURS * MILLISECONDS_PER_HOUR);
  if (sendAtUtc <= now) return { scheduled: false, reason: 'INSIDE_LEAD_WINDOW' };

  const collection = await jobsCol();
  const interviewOid = toOid(interview._id);
  for (const recipientKind of Object.values(REMINDER_RECIPIENT_KINDS)) {
    await collection.updateOne(
      { interviewId: interviewOid, recipientKind },
      {
        $set: {
          sendAtUtc,
          status: REMINDER_JOB_STATUS.PENDING,
          attemptCount: 0,
          claimedAt: null,
          completedAt: null,
          lastError: null,
          updatedAt: now,
        },
        $setOnInsert: {
          interviewId: interviewOid,
          companyId: toOid(interview.companyId),
          recipientKind,
          createdAt: now,
        },
      },
      { upsert: true },
    );
  }
  return { scheduled: true, sendAtUtc };
}

/** Flip pending/claimed reminders to cancelled. Returns the count flipped. */
export async function cancelInterviewReminders(interviewId, now = new Date()) {
  const interviewOid = toOid(interviewId);
  if (!interviewOid) return 0;
  const collection = await jobsCol();
  const result = await collection.updateMany(
    { interviewId: interviewOid, status: { $in: [REMINDER_JOB_STATUS.PENDING, REMINDER_JOB_STATUS.CLAIMED] } },
    { $set: { status: REMINDER_JOB_STATUS.CANCELLED, updatedAt: now } },
  );
  return result.modifiedCount;
}

/** Atomically claim the oldest due pending job. Concurrent sweeps are safe:
 *  the status predicate hands each job to exactly one caller. */
export async function claimDueReminderJob(now = new Date()) {
  const collection = await jobsCol();
  return collection.findOneAndUpdate(
    { status: REMINDER_JOB_STATUS.PENDING, sendAtUtc: { $lte: now } },
    {
      $set: { status: REMINDER_JOB_STATUS.CLAIMED, claimedAt: now, updatedAt: now },
      $inc: { attemptCount: 1 },
    },
    { sort: { sendAtUtc: 1 }, returnDocument: 'after' },
  );
}

/** Mark a claimed job sent. completedAt starts the TTL clock. */
export async function completeReminderJob(jobId, now = new Date()) {
  await (await jobsCol()).updateOne(
    { _id: toOid(jobId) },
    { $set: { status: REMINDER_JOB_STATUS.COMPLETED, completedAt: now, lastError: null, updatedAt: now } },
  );
}

/** Requeue with backoff: back to pending, sendAtUtc pushed out. attemptCount stays. */
export async function requeueReminderJobWithBackoff(jobId, errorMessage, backoffSeconds, now = new Date()) {
  await (await jobsCol()).updateOne(
    { _id: toOid(jobId) },
    {
      $set: {
        status: REMINDER_JOB_STATUS.PENDING,
        sendAtUtc: new Date(now.getTime() + backoffSeconds * 1000),
        lastError: String(errorMessage ?? ''),
        claimedAt: null,
        updatedAt: now,
      },
    },
  );
}

/** Terminal failure. completedAt is stamped so the TTL still reaps the row. */
export async function failReminderJob(jobId, errorMessage, now = new Date()) {
  await (await jobsCol()).updateOne(
    { _id: toOid(jobId) },
    { $set: { status: REMINDER_JOB_STATUS.FAILED, lastError: String(errorMessage ?? ''), completedAt: now, updatedAt: now } },
  );
}

/** Cancel one claimed job (its interview is no longer scheduled). */
export async function cancelReminderJob(jobId, now = new Date()) {
  await (await jobsCol()).updateOne(
    { _id: toOid(jobId) },
    { $set: { status: REMINDER_JOB_STATUS.CANCELLED, updatedAt: now } },
  );
}

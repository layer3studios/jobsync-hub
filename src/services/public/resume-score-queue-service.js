// FILE: src/services/public/resume-score-queue-service.js
// Enqueue side of the applicant-scoring queue (Q1 D3). The apply POST calls
// enqueueScoreJob fire-and-forget: it NEVER throws — a failed enqueue is caught,
// logged, and returns a null-shape so an application can never fail because scoring
// could not be queued (C8). companyId + postingId are stored on the job so the
// worker stays multi-tenant safe without ambient context.

import {
  insertScoreJob, getScoreJobForApplication,
} from '../../models/public/resume-score-job-model.js';

/**
 * Enqueue a score job for one application. Idempotent (R5) — a second call for the
 * same applicationId returns alreadyExisted: true. Never rejects: on failure logs
 * and returns { jobId: null, alreadyExisted: false, enqueued: false }.
 */
export async function enqueueScoreJob(applicationId, companyId, postingId) {
  try {
    const result = await insertScoreJob(applicationId, companyId, postingId);
    return { ...result, enqueued: true };
  } catch (err) {
    console.warn('[score-queue] enqueue failed:', err?.message || err);
    return { jobId: null, alreadyExisted: false, enqueued: false };
  }
}

/** Read the queue-lifecycle status of one application's score job (future UI, Q1 D3). */
export async function getScoreJobStatusForApplication(applicationId) {
  const job = await getScoreJobForApplication(applicationId);
  if (!job) return null;
  return {
    jobId: job._id.toString(),
    status: job.status,
    attemptCount: job.attemptCount ?? 0,
    errorCode: job.errorCode ?? null,
    nextTryAt: job.nextTryAt ?? null,
    completedAt: job.completedAt ?? null,
  };
}

export default enqueueScoreJob;

// FILE: src/services/employer/rescore-service.js
// Manual "rescore this applicant" action (T1.2). Puts the application's score job
// back into the queue; the worker then processes it exactly as it would a fresh one
// — same retry/backoff/denylist semantics, no special-casing (D6).
//
// Idempotent (C9): an application whose job is already queued or processing is a
// no-op — we return its current status rather than resetting attemptCount out from
// under a worker that is mid-claim. done/failed jobs reset; a missing job inserts.
//
// The existing resume_scores row is never read or written here. The worker's
// upsertResumeScore overwrites it atomically when the new score lands, so the
// employer keeps seeing the old score until then (C13).

import { HttpError } from '../../middleware/error-handler-middleware.js';
import { getApplicationForCompany } from '../../models/public/application-model.js';
import {
  enqueueRescoreJob, getScoreJobStatusForApplication,
} from '../public/resume-score-queue-service.js';
import { SCORE_JOB_STATUS } from '../../models/public/resume-score-job-model.js';

/** Statuses that mean a worker owns this job right now — leave it alone. */
const IN_FLIGHT_STATUSES = new Set([SCORE_JOB_STATUS.QUEUED, SCORE_JOB_STATUS.PROCESSING]);

/**
 * Requeue one applicant's scoring job for the owning company.
 * Returns { rescored, jobStatus, jobId, attemptCount } (C10). `rescored: false`
 * means the job was already in flight and nothing changed — the route answers 200.
 */
export async function rescoreApplicantForCompany(companyId, applicationId) {
  const application = await getApplicationForCompany(companyId, applicationId);
  if (!application) {
    // The route's middleware already 404s cross-tenant ids; this is defence in depth.
    console.warn('[rescore] application not found for company:', String(applicationId));
    throw new HttpError(404, 'Application not found', 'APPLICATION_NOT_FOUND');
  }
  // Defence in depth (C8): never act on a document from another tenant.
  if (String(application.companyId) !== String(companyId)) {
    throw new HttpError(404, 'Application not found', 'APPLICATION_NOT_FOUND');
  }

  const current = await getScoreJobStatusForApplication(application._id);
  if (current && IN_FLIGHT_STATUSES.has(current.status)) {
    return {
      rescored: false,
      jobStatus: current.status,
      jobId: current.jobId,
      attemptCount: current.attemptCount,
    };
  }

  const result = await enqueueRescoreJob(application._id, application.companyId, application.jobId);
  if (!result.enqueued) {
    throw new HttpError(500, 'Could not queue a rescore. Please try again.', 'RESCORE_ENQUEUE_FAILED');
  }
  return {
    rescored: true,
    jobStatus: result.jobStatus,
    jobId: result.jobId,
    attemptCount: result.attemptCount,
  };
}

export default rescoreApplicantForCompany;

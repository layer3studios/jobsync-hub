// FILE: src/services/seeker/resume-parse-job-service.js
// Read side of the parse queue (D4): the polling endpoint's data source. Ownership
// is enforced at the model (getJobForUser is userId-scoped, §6.5) so another user's
// jobId reads as "not found", never a leak. The returned shape is toPublicJob —
// tmpPath and resumeText never cross this boundary.

import { getJobForUser, toPublicJob } from '../../models/seeker/resume-parse-job-model.js';

/** Return the client-safe status of one job owned by userId, or null if not theirs. */
export async function getJobStatusForUser(userId, jobId) {
  const job = await getJobForUser(userId, jobId);
  return job ? toPublicJob(job) : null;
}

export default getJobStatusForUser;

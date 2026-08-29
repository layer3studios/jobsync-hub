// FILE: src/services/admin/indexing-worker.js
// Drains the indexing_jobs queue, cloned in shape from resume-score-worker:
// recover stuck jobs once at boot, then a poll loop that claims one job at a time
// and never dies on a throw.
//
// QUOTA IS THE INTERESTING CASE. Google allows 200 URLs/day and answers 429 when
// that is spent. A 429 is OUR failure, not the job's, so the job is released
// WITHOUT consuming an attempt and the whole loop pauses for an hour — retrying
// immediately would burn the loop against a wall that only moves at midnight.
//
// Unconfigured (no service account) means one boot log line and no loop at all.

import {
  claimNextIndexingJob, markIndexingJobDone, markIndexingJobFailed,
  releaseIndexingJob, resetStuckIndexingJobs, MAX_ATTEMPTS,
} from '../../models/admin/indexing-job-model.js';
import { buildIndexingClient } from './google-indexing-client.js';

const POLL_INTERVAL_MS = 60_000;
const QUOTA_BACKOFF_MS = 60 * 60_000;
const QUOTA_STATUS = 429;

let isStopped = false;
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); });

/**
 * Claim and submit one job. Returns { job, outcome } — outcome 'quota' tells the
 * loop to back off. Never throws.
 */
export async function processNextIndexingJob(client, deps = {}) {
  const {
    claim = claimNextIndexingJob,
    markDone = markIndexingJobDone,
    markFailed = markIndexingJobFailed,
    release = releaseIndexingJob,
  } = deps;

  const job = await claim();
  if (!job) return { job: null, outcome: 'idle' };

  try {
    const result = await client.publishUrl(job.url, job.action);

    if (result.ok) {
      await markDone(job._id);
      return { job, outcome: 'done' };
    }

    if (result.status === QUOTA_STATUS) {
      // Not this job's fault — hand it back intact.
      await release(job._id, result.error);
      console.warn('[indexing] daily quota reached — pausing for 1h');
      return { job, outcome: 'quota' };
    }

    const retry = job.attemptCount < MAX_ATTEMPTS;
    await markFailed(job._id, result.error, { retry });
    return { job, outcome: retry ? 'retry' : 'failed' };
  } catch (err) {
    const retry = job.attemptCount < MAX_ATTEMPTS;
    await markFailed(job._id, err?.message ?? String(err), { retry });
    return { job, outcome: retry ? 'retry' : 'failed' };
  }
}

/** One loop iteration, exported so a test can drive it without timers. */
export async function runIndexingIteration(client, deps = {}) {
  const { process: processOne = processNextIndexingJob, sleepFn = sleep } = deps;
  try {
    const { outcome } = await processOne(client, deps);
    if (outcome === 'quota') await sleepFn(QUOTA_BACKOFF_MS);
    else if (outcome === 'idle') await sleepFn(POLL_INTERVAL_MS);
  } catch (err) {
    // A transient throw must never kill the loop.
    console.warn(`[indexing] loop error (${err?.message ?? err}) — retrying`);
    await sleepFn(POLL_INTERVAL_MS);
  }
}

/** Start the singleton worker. No-ops with one log line when unconfigured. */
export async function startIndexingWorker(deps = {}) {
  const { buildClient = buildIndexingClient, resetStuck = resetStuckIndexingJobs } = deps;
  const client = buildClient();
  if (!client) {
    console.log('[indexing] worker not started — no service account configured');
    return { started: false };
  }

  const recovered = await resetStuck().catch(() => 0);
  console.log(`[indexing] worker started (recovered ${recovered} stuck jobs)`);

  (async () => {
    while (!isStopped) await runIndexingIteration(client, deps);
  })();

  return { started: true };
}

export function stopIndexingWorker() {
  isStopped = true;
}

export default startIndexingWorker;

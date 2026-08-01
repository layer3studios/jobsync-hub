// FILE: src/services/interview/interview-reminder-worker.js
// 24h reminder sweep, mirroring resume-score-worker: atomic claim loop, 3
// attempts with 30s/60s backoff, no-op under NODE_ENV==='test', graceful stop
// between sweeps. Sweeps every 5 minutes and drains ALL due jobs per sweep; the
// atomic claim makes concurrent sweeps safe — no extra lock. companyId always
// comes from the job document, never from anywhere else.

import { NODE_ENV, INTERVIEW_REMINDERS_ENABLED } from '../../env.js';
import {
  claimDueReminderJob, completeReminderJob, requeueReminderJobWithBackoff,
  failReminderJob, cancelReminderJob,
} from '../../models/interview/interview-reminder-job-model.js';
import { getInterviewForCompany as defaultGetInterview } from '../../models/interview/interview-model.js';
import { INTERVIEW_STATUSES } from '../../models/interview/interview-constants.js';
import { buildInterviewEmailContext as defaultBuildContext } from './interview-context-helpers.js';
import { sendInterviewReminderEmail as defaultSendReminder } from './interview-notification-service.js';
import { checkPoolLevelsAndNotify } from './pool-monitor-service.js';
import { sendDueFeedbackRequests } from './interview-feedback-request-service.js';

const SWEEP_INTERVAL_MILLISECONDS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 3;
const BACKOFF_SECONDS = [30, 60]; // indexed by attemptCount-1; attempt 3 is terminal

let isStopped = false;
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); });

async function handleSendFailure(job, message) {
  if (job.attemptCount < MAX_ATTEMPTS) {
    const backoff = BACKOFF_SECONDS[job.attemptCount - 1] || 60;
    await requeueReminderJobWithBackoff(job._id, message, backoff, new Date());
    console.log(`[reminder-queue] requeued ${job._id} attempt=${job.attemptCount}/${MAX_ATTEMPTS} backoff=${backoff}s`);
  } else {
    await failReminderJob(job._id, message, new Date());
    console.log(`[reminder-queue] failed ${job._id} terminal after ${job.attemptCount} attempts`);
  }
}

/** Process one claimed job. Never throws. */
export async function processReminderJob(job, deps = {}) {
  const {
    getInterview = defaultGetInterview,
    buildContext = defaultBuildContext,
    sendReminder = defaultSendReminder,
  } = deps;
  try {
    // companyId from the job document — the worker's only tenant context.
    const interview = await getInterview(job.companyId, job.interviewId);
    if (!interview || interview.status !== INTERVIEW_STATUSES.SCHEDULED) {
      await cancelReminderJob(job._id);
      console.log(`[reminder-queue] cancelled ${job._id} — interview no longer scheduled`);
      return { outcome: 'cancelled' };
    }
    const context = await buildContext(interview, deps);
    if (!context) {
      await failReminderJob(job._id, 'related records missing', new Date());
      return { outcome: 'failed' };
    }
    const summary = await sendReminder(context, job.recipientKind, deps);
    if (summary.failed > 0) {
      await handleSendFailure(job, `send failed (${summary.failed}/${summary.attempted})`);
      return { outcome: 'retried' };
    }
    await completeReminderJob(job._id, new Date());
    console.log(`[reminder-queue] sent ${job._id} kind=${job.recipientKind}`);
    return { outcome: 'completed' };
  } catch (err) {
    await handleSendFailure(job, err?.message || String(err));
    return { outcome: 'retried' };
  }
}

/** Drain every due job. Safe to run concurrently — the claim is the lock. */
export async function processDueReminderJobs(now = new Date(), deps = {}) {
  const { claim = claimDueReminderJob, process = processReminderJob } = deps;
  let processedCount = 0;
  for (;;) {
    const job = await claim(now);
    if (!job) break;
    await process(job, deps);
    processedCount += 1;
  }
  return processedCount;
}

async function runSweepLoop() {
  while (!isStopped) {
    try {
      await processDueReminderJobs(new Date());
      // Pool-low watchdog rides the same sweep; it never throws.
      await checkPoolLevelsAndNotify(new Date());
      // Post-interview feedback nudge rides it too; it never throws either.
      await sendDueFeedbackRequests(new Date());
    } catch (err) {
      console.log(`[reminder-queue] sweep error (${err?.message || err}) — next sweep in ${SWEEP_INTERVAL_MILLISECONDS}ms`);
    }
    await sleep(SWEEP_INTERVAL_MILLISECONDS);
  }
}

/** Start the sweep. No-op under test or when INTERVIEW_REMINDERS_ENABLED=false. */
export function startInterviewReminderWorker() {
  if (NODE_ENV === 'test') return;
  if (!INTERVIEW_REMINDERS_ENABLED) {
    console.log('[reminder-queue] disabled via INTERVIEW_REMINDERS_ENABLED=false');
    return;
  }
  isStopped = false;
  console.log(`[reminder-queue] starting — sweep every ${SWEEP_INTERVAL_MILLISECONDS / 60000} minutes`);
  runSweepLoop();
}

export function stopInterviewReminderWorker() {
  isStopped = true;
}

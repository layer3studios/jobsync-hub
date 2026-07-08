// FILE: src/services/public/resume-score-worker.js
// In-process applicant-scoring worker (Q1 D4, R2/R3). Spawns N independent slots
// where N = min(configured Gemma keys, 5). Each slot polls, atomically claims a
// ready job, calls the existing scoreApplication(applicationId), and marks the job
// done/requeued/failed. Slots are pure concurrency control — they do NOT own Gemma
// keys; the key-manager round-robins per call (R3). Retries 3x with 30s/60s backoff.
// Q1-HARDEN: scoreApplication swallows its errors onto resume_scores.processingError
// (scoring-service.js:89-93), so the ROW — not a throw — is the failure signal; we
// read it back and retry transient failures / fail fast on terminal ones (Bug A). The
// slot loop is hardened so a transient DB/network throw never kills a slot (Bug B).

import { GEMMA_API_KEYS, NODE_ENV } from '../../env.js';
import { scoreApplication as defaultScoreApplication } from './scoring-service.js';
import { getResumeScoreForApplication } from '../../models/public/resume-score-model.js';
import {
  claimNextScoreJob, markScoreJobDone, markScoreJobFailedTerminal,
  requeueScoreJobWithBackoff, resetStuckScoreJobs, SCORE_JOB_ERROR,
} from '../../models/public/resume-score-job-model.js';

const POLL_INTERVAL_MILLISECONDS = 1000;
const MAX_ATTEMPTS = 3;
const BACKOFF_SECONDS = [30, 60]; // indexed by attemptCount-1; attempt 3 is terminal
const MAX_SLOTS_CAP = 5;
const SCORE_ROW_MISSING = 'SCORE_ROW_MISSING';

// Denylist not allowlist (Q1-HARDEN F): only permanent input failures have stable
// codes; transient Gemma errors arrive as free-text, so retryable = NOT known-terminal.
const TERMINAL_PROCESSING_ERRORS = new Set([
  'NO_RESUME_FILE',     // scoring-service.js:59 — no resume attached, never resolves
  'PDF_UNREADABLE',     // scoring-service.js:67,70 — resume can't be read, permanent
  'NO_JD_REQUIREMENTS', // scoring-service.js:75 — posting has no parsedRequirements
  SCORE_ROW_MISSING,    // no row at all post-scoring — a programming error, not transient
]);

const isRetryableFailure = (code) => !TERMINAL_PROCESSING_ERRORS.has(code);
let isStopped = false;

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); });

/** How many slots to run: one per configured key, capped at 5, floor of 1 (R2). */
export function computeSlotCount(keysString = GEMMA_API_KEYS) {
  const keyCount = String(keysString || '')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean)
    .length;
  return Math.min(Math.max(keyCount, 1), MAX_SLOTS_CAP);
}

/** Read the scoring outcome from the resume_scores row (Bug A) — the row IS the contract (R5). */
export async function interpretScoringResult(applicationId) {
  const row = await getResumeScoreForApplication(applicationId);
  if (!row) return { ok: false, retryable: false, code: SCORE_ROW_MISSING, message: 'no score row after scoring' };
  if (!row.processingError) return { ok: true };
  const code = row.processingError;
  return { ok: false, retryable: isRetryableFailure(code), code, message: code };
}

/** Apply the shared retry/terminal decision to a failure (from a throw or the row). */
async function handleFailure(job, slotIndex, code, message, retryable, source) {
  if (retryable && job.attemptCount < MAX_ATTEMPTS) {
    const backoff = BACKOFF_SECONDS[job.attemptCount - 1] || 60;
    await requeueScoreJobWithBackoff(job._id, code, message, backoff, new Date());
    console.log(`[score-queue] slot ${slotIndex} requeued ${job._id} (${code} source=${source}) attempt=${job.attemptCount}/${MAX_ATTEMPTS} backoff=${backoff}s`);
    return;
  }
  const exhausted = retryable; // retryable but out of attempts vs. non-retryable
  const finalCode = exhausted ? SCORE_JOB_ERROR.MAX_ATTEMPTS_EXCEEDED : code;
  const finalMessage = exhausted ? `underlying=${code} ${message}` : message; // preserve cause (R4)
  await markScoreJobFailedTerminal(job._id, finalCode, finalMessage, new Date());
  console.log(`[score-queue] slot ${slotIndex} failed ${job._id} (${finalCode} source=${source}) terminal=${exhausted ? 'retryable-exhausted' : 'non-retryable'}`);
}

/** Claim and process one ready job for a slot. Returns the claimed job, or null if idle. */
export async function pollAndProcess(slotIndex, now = new Date(), deps = {}) {
  const { scoreApplication = defaultScoreApplication, interpretResult = interpretScoringResult } = deps;
  const job = await claimNextScoreJob(slotIndex, now);
  if (!job) return null;
  console.log(`[score-queue] slot ${slotIndex} started ${job._id} app=${job.applicationId} attempt=${job.attemptCount}`);
  try {
    await scoreApplication(job.applicationId);
    const result = await interpretResult(job.applicationId);
    if (result.ok) {
      await markScoreJobDone(job._id, new Date());
      console.log(`[score-queue] slot ${slotIndex} done ${job._id}`);
    } else {
      await handleFailure(job, slotIndex, result.code, result.message, result.retryable, 'result');
    }
  } catch (err) {
    const code = err?.code || SCORE_JOB_ERROR.UNKNOWN;
    await handleFailure(job, slotIndex, code, err?.message || String(err), isRetryableFailure(code), 'throw');
  }
  return job;
}

/** One slot-loop iteration. Bug B: a transient throw is caught+logged so the slot never dies. */
export async function runSlotIteration(slotIndex, deps = {}) {
  const { poll = pollAndProcess, sleepFn = sleep, now = new Date() } = deps;
  try {
    const job = await poll(slotIndex, now);
    if (!job) await sleepFn(POLL_INTERVAL_MILLISECONDS);
  } catch (err) {
    console.log(`[score-queue] slot ${slotIndex} loop error (${err?.message || err}) — retrying in ${POLL_INTERVAL_MILLISECONDS}ms`);
    await sleepFn(POLL_INTERVAL_MILLISECONDS);
  }
}

/** One slot's poll loop: iterate until stopped. */
async function runSlot(slotIndex) {
  while (!isStopped) await runSlotIteration(slotIndex);
}

/**
 * Start the worker: recover stuck jobs once, then spawn N isolated slots. No-op
 * under NODE_ENV==='test' so importing/booting server.js never spawns real slots
 * (V3). Does not block boot — slots run in the background.
 */
export async function startScoreWorker() {
  if (NODE_ENV === 'test') return;
  isStopped = false;
  const reset = await resetStuckScoreJobs();
  const slotCount = computeSlotCount();
  console.log(`[score-queue] starting ${slotCount} slots (recovered ${reset} stuck jobs)`);
  const slots = Array.from({ length: slotCount }, (_, i) => runSlot(i));
  Promise.allSettled(slots); // isolate slot failures — one dying never cascades
}

/** Stop all slots between polls (tests / graceful shutdown). */
export function stopScoreWorker() {
  isStopped = true;
}

export default startScoreWorker;

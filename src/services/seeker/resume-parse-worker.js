// FILE: src/services/seeker/resume-parse-worker.js
// In-process resume-parse worker (D3, R2). A singleton poll loop claims one queued
// job per second and runs the real 30-40s parse off the request path: extract text
// (PDF) or read it inline (text) → Gemma parse → store profile → delete temp file →
// mark done. Any failure is caught, mapped to a stable code, the temp file is still
// deleted (C8), and the job is marked failed. On boot it requeues crash-stranded
// jobs (R4) and sweeps temp files older than 1h (C8). Concurrency is 1 for MVP.

import { extractTextFromPDF } from './resume-text-extractor.js';
import { parseResumeText } from './resume-parser-service.js';
import { upsertProfileForUser } from '../../models/seeker/seeker-profile-helpers.js';
import {
  claimNextQueuedJob, markJobDone, markJobFailed, resetStuckJobs,
} from '../../models/seeker/resume-parse-job-model.js';
import { readTmpFile, deleteTmpFile, sweepOldTmpFiles } from './resume-tmp-storage.js';

const POLL_INTERVAL_MS = 1000;
let started = false;
let timer = null;
let running = false;

/** Resolve the resume text for a job from its temp PDF or inline text. */
async function resolveText(job) {
  if (job.source === 'text') return String(job.resumeText ?? '');
  const buffer = readTmpFile(job.tmpPath);
  const { text } = await extractTextFromPDF(buffer);
  return text;
}

/** Process one claimed job end-to-end. Exported for tests. */
export async function processOneJob(job) {
  const id = job._id.toString();
  const startedAt = Date.now();
  console.log(`[queue] job ${id} started`);
  try {
    const text = await resolveText(job);
    const profile = await parseResumeText(text);
    await upsertProfileForUser(job.userId, profile, job.fileHash);
    await markJobDone(id, { profile, isUnchanged: false });
    console.log(`[queue] job ${id} done in ${Date.now() - startedAt}ms`);
  } catch (err) {
    const errorCode = err?.code || 'RESUME_PARSE_FAILED';
    await markJobFailed(id, errorCode, err?.message || 'Resume parsing failed.');
    console.log(`[queue] job ${id} failed`);
  } finally {
    deleteTmpFile(job.tmpPath);
  }
}

/** Claim and process the next queued job, if any. Returns true when one ran. */
export async function tick() {
  if (running) return false;
  running = true;
  try {
    const job = await claimNextQueuedJob();
    if (!job) return false;
    await processOneJob(job);
    return true;
  } finally {
    running = false;
  }
}

/** Start the singleton worker: recover stuck jobs, sweep temp files, begin polling. */
export async function startResumeParseWorker() {
  if (started) return;
  started = true;
  await resetStuckJobs();
  sweepOldTmpFiles();
  timer = setInterval(() => { void tick(); }, POLL_INTERVAL_MS);
  timer.unref?.();
}

/** Stop the poll loop (tests / graceful shutdown). */
export function stopResumeParseWorker() {
  if (timer) clearInterval(timer);
  timer = null;
  started = false;
}

export default startResumeParseWorker;

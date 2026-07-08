// FILE: src/services/seeker/resume-upload-service.js
// Enqueues a resume for async parsing (F1). SHA-256 dedup stays synchronous and
// cheap: an unchanged hash short-circuits to the stored profile with no queue work
// ({ jobId: null }). Otherwise the PDF buffer is written to a short-lived temp file
// (text is kept inline) and a queued job is inserted — the endpoint returns a jobId
// in <500ms and the worker (resume-parse-worker.js) does the 30-40s parse off-band.

import crypto from 'crypto';
import { getProfileForUser, getResumeHashForUser } from '../../models/seeker/seeker-profile-helpers.js';
import { insertResumeParseJob } from '../../models/seeker/resume-parse-job-model.js';
import { writeTmpPdf } from './resume-tmp-storage.js';

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/** Fast-path dedup: return the stored profile when the hash is unchanged, else null. */
async function dedupProfile(userId, hash) {
  const previousHash = await getResumeHashForUser(userId);
  if (previousHash && previousHash === hash) {
    return { profile: await getProfileForUser(userId), isUnchanged: true, jobId: null };
  }
  return null;
}

/** Enqueue a PDF resume for parsing. Returns { jobId, status } or a dedup fast path. */
export async function processResumeUpload(userId, buffer) {
  const hash = sha256(buffer);
  const unchanged = await dedupProfile(userId, hash);
  if (unchanged) return unchanged;

  const tmpPath = writeTmpPdf(buffer);
  const job = await insertResumeParseJob({ userId, source: 'pdf', tmpPath, fileHash: hash });
  return { jobId: job._id.toString(), status: 'queued' };
}

/** Enqueue pasted resume text for parsing. Returns { jobId, status } or a dedup fast path. */
export async function processResumeText(userId, text) {
  const hash = sha256(Buffer.from(text, 'utf8'));
  const unchanged = await dedupProfile(userId, hash);
  if (unchanged) return unchanged;

  const job = await insertResumeParseJob({ userId, source: 'text', resumeText: text, fileHash: hash });
  return { jobId: job._id.toString(), status: 'queued' };
}

export default processResumeUpload;

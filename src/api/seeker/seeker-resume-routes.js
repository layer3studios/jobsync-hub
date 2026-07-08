// FILE: src/api/seeker/seeker-resume-routes.js
// Resume upload + paste endpoints, mounted at /api/seeker/resume behind
// requireSeeker + requireConsentForPurpose('resume_parsing') (server.js). multer
// uses MEMORY storage only — the PDF buffer never touches disk (C9). multer's own
// errors (size/type) are mapped to stable codes here.

import { Router } from 'express';
import multer from 'multer';
import { asyncHandler } from '../../middleware/async-handler-middleware.js';
import { HttpError } from '../../middleware/error-handler-middleware.js';
import { processResumeUpload, processResumeText } from '../../services/seeker/resume-upload-service.js';
import { getJobStatusForUser } from '../../services/seeker/resume-parse-job-service.js';
import { runResumeReviewForUser, getResumeReviewForUser } from '../../services/seeker/resume-review-service.js';

const router = Router();
const MAX_BYTES = 5 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'application/pdf') return cb(null, true);
    return cb(new HttpError(400, 'Only PDF resumes are accepted.', 'INVALID_FILE_TYPE'));
  },
}).single('resume');

/** Run multer, translating its errors into stable HttpError codes. */
function runUpload(req, res) {
  return new Promise((resolve, reject) => {
    upload(req, res, (err) => {
      if (!err) return resolve();
      if (err instanceof HttpError) return reject(err);
      if (err.code === 'LIMIT_FILE_SIZE') {
        return reject(new HttpError(400, 'Resume must be 5MB or smaller.', 'FILE_TOO_LARGE'));
      }
      return reject(new HttpError(400, 'Could not read the uploaded file.', 'UPLOAD_FAILED'));
    });
  });
}

// POST /upload — multipart PDF (field name "resume"). Enqueues + returns a jobId
// (<500ms); the dedup fast path still returns the stored profile inline (D2).
router.post('/upload', asyncHandler(async (req, res) => {
  await runUpload(req, res);
  if (!req.file) throw new HttpError(400, 'No resume file was provided.', 'NO_FILE');
  const result = await processResumeUpload(req.user.userId, req.file.buffer);
  res.json(result);
}));

// POST /text — pasted resume text fallback. Same enqueue contract as /upload.
router.post('/text', asyncHandler(async (req, res) => {
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  if (text.length < 200 || text.length > 100000) {
    throw new HttpError(400, 'Resume text must be between 200 and 100,000 characters.', 'INVALID_RESUME_TEXT');
  }
  const result = await processResumeText(req.user.userId, text);
  res.json(result);
}));

// POST /review — run a fresh Gemma review of the stored profile and persist it.
router.post('/review', asyncHandler(async (req, res) => {
  const review = await runResumeReviewForUser(req.user.userId);
  res.json({ review });
}));

// GET /review — the cached review, or { review: null } when none has run yet.
router.get('/review', asyncHandler(async (req, res) => {
  const review = await getResumeReviewForUser(req.user.userId);
  res.json({ review });
}));

// GET /jobs/:jobId — poll parse status. Ownership enforced in the service (§6.5).
router.get('/jobs/:jobId', asyncHandler(async (req, res) => {
  const job = await getJobStatusForUser(req.user.userId, req.params.jobId);
  if (!job) throw new HttpError(404, 'Job not found.', 'JOB_NOT_FOUND');
  res.json({ job });
}));

export default router;

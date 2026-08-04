// FILE: src/api/public/assignment-staging-routes.js
// Unauthenticated staging upload for take-home assignment files, mounted at
// /api/public/assignment-files. A seeker uploads before they submit, so this runs
// with NO cookie and NO session — deliberately, matching the rest of the apply
// flow. Ownership comes entirely from the signed fileId we hand back: a guessed
// uuid is worthless because it carries no valid signature.
//
// Storage is DISK-backed, never multer.memoryStorage(): at a 10MB limit, buffering
// uploads in memory on a single pm2 fork is a trivial denial of service. Bytes go
// straight from the socket to data/assignment-staging/{uuid}.{ext} and are never
// held whole in the process.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { Router } from 'express';
import multer from 'multer';
import rateLimit, { ipKeyGenerator, MemoryStore } from 'express-rate-limit';
import { asyncHandler } from '../../middleware/async-handler-middleware.js';
import { HttpError } from '../../middleware/error-handler-middleware.js';
import {
  ensureAssignmentDirectories, stagedPathFor, deleteStagedFile, stagingDirectoryPath,
} from '../../services/public/assignment-storage-service.js';
import { signStagedFileToken } from '../../services/employer/assignment-signed-url-service.js';

const router = Router();
const HOUR = 60 * 60 * 1000;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_ORIGINAL_NAME = 128;

/**
 * Accepted (ext, mimetype) pairs. BOTH must agree or the upload is refused.
 *
 * Known ceiling: extension and MIME type are both attacker-controlled, so this
 * catches honest mistakes and lazy attacks, not a determined one — a renamed .exe
 * with a forged application/pdf header passes. Magic-byte sniffing is listed
 * hardening (X1) and is deliberately NOT done here; .md has no magic bytes at all,
 * so for markdown this pairing is the ceiling regardless.
 */
const ACCEPTED_TYPES = {
  pdf: ['application/pdf'],
  zip: ['application/zip', 'application/x-zip-compressed'],
  md: ['text/markdown', 'text/plain'],
};

/** The extension key for an upload, or null when ext and MIME disagree. */
function acceptedExtension(originalname, mimetype) {
  const ext = path.extname(String(originalname || '')).slice(1).toLowerCase();
  const allowedMimes = ACCEPTED_TYPES[ext];
  if (!allowedMimes || !allowedMimes.includes(mimetype)) return null;
  return ext;
}

/**
 * Sanitize the DISPLAY name. The on-disk name is always the uuid, so this only has
 * to be safe for a Content-Disposition header and for rendering in the employer UI
 * — but it still strips separators so a traversal string can never reach a path.
 */
function sanitizeOriginalName(name) {
  const withoutPaths = String(name || '').replace(/[\\/]/g, ' ');
  const cleaned = withoutPaths.replace(/[^A-Za-z0-9._\- ]/g, '_').replace(/[_\s]{2,}/g, ' ').trim();
  return cleaned.slice(0, MAX_ORIGINAL_NAME) || 'file';
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    ensureAssignmentDirectories();
    cb(null, stagingDirectoryPath());
  },
  filename: (_req, file, cb) => {
    // Never the candidate's filename — a random uuid keeps traversal and collisions
    // impossible by construction.
    cb(null, `${crypto.randomUUID()}.${file.assignmentExt}`);
  },
});

const upload = multer({
  storage,
  // busboy treats limits.fileSize as an EXCLUSIVE ceiling — it aborts at
  // size >= fileSize, so passing MAX_FILE_BYTES would reject a file of exactly
  // 10MB. +1 makes the accepted maximum exactly MAX_FILE_BYTES, which is what the
  // error message promises. (The apply route's 5MB limit has the same off-by-one;
  // out of scope to change here.)
  limits: { fileSize: MAX_FILE_BYTES + 1, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ext = acceptedExtension(file.originalname, file.mimetype);
    if (!ext) return cb(new HttpError(415, 'That file type is not accepted.', 'UNSUPPORTED_FILE_TYPE'));
    file.assignmentExt = ext;
    return cb(null, true);
  },
}).single('file');

/**
 * This endpoint's own limiter — deliberately NOT one of the apply limiters. It is
 * unauthenticated and accepts 10MB per call, so it needs a tighter budget than a
 * text-mostly apply POST.
 *
 * Every rejection is logged. Indian applicants very often share one NAT'd egress IP
 * — college placement drives, cybercafes, shared coworking offices — so a per-IP
 * ceiling can punish a room full of legitimate candidates. We need to see whether
 * that is actually happening before deciding to raise the limit or move to
 * per-session keying, and a silent 429 tells us nothing.
 */
// Exported ONLY so the test suite can isolate cases from one another; no src code
// touches it. Declared explicitly rather than left implicit so that reset is possible.
export const stagingRateLimitStore = new MemoryStore();

const stagingLimiter = rateLimit({
  windowMs: HOUR,
  limit: 20,
  store: stagingRateLimitStore,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip),
  handler: (req, res, _next, options) => {
    const ipPrefix = String(req.ip || '').split(':')[0].split('.').slice(0, 2).join('.');
    console.warn(`[assignment-upload] rate limited ip=${ipPrefix}.x.x at ${new Date().toISOString()}`);
    res.status(options.statusCode).json(options.message);
  },
  message: { error: 'Too many uploads. Try again later.', code: 'RATE_LIMITED' },
});

/** Run multer, translating size/type errors into stable codes. */
function runUpload(req, res) {
  return new Promise((resolve, reject) => {
    upload(req, res, (err) => {
      if (!err) return resolve();
      if (err instanceof HttpError) return reject(err);
      if (err.code === 'LIMIT_FILE_SIZE') return reject(new HttpError(400, 'File must be 10MB or smaller.', 'FILE_TOO_LARGE'));
      return reject(new HttpError(400, 'Could not read the uploaded file.', 'UPLOAD_FAILED'));
    });
  });
}

// POST /api/public/assignment-files — stage one file, return a signed fileId.
router.post('/', stagingLimiter, asyncHandler(async (req, res) => {
  try {
    await runUpload(req, res);
  } catch (err) {
    // Multer may have already written bytes (e.g. LIMIT_FILE_SIZE aborts mid-write).
    // Never leave an orphan behind on a request that failed.
    if (req.file?.path) { try { fs.unlinkSync(req.file.path); } catch { /* already gone */ } }
    throw err;
  }

  if (!req.file) throw new HttpError(400, 'No file was uploaded.', 'NO_FILE');

  const ext = req.file.assignmentExt;
  const uuid = path.basename(req.file.filename, `.${ext}`);
  const originalName = sanitizeOriginalName(req.file.originalname);
  const storagePath = stagedPathFor(uuid, ext);

  try {
    const { token, expiresAt } = signStagedFileToken({
      uuid, ext, originalName, sizeBytes: req.file.size, mimeType: req.file.mimetype,
    });
    // storagePath is NEVER returned — the client gets an opaque fileId only.
    res.status(201).json({
      fileId: token,
      originalName,
      sizeBytes: req.file.size,
      mimeType: req.file.mimetype,
      expiresAt: new Date(expiresAt).toISOString(),
    });
  } catch (err) {
    deleteStagedFile(storagePath);
    throw err;
  }
}));

export default router;

// FILE: src/api/public/assignment-download-route.js
// Unauthenticated download of one assignment file. Access is granted solely by a
// valid short-lived HMAC token — no cookie, same shape as resume-download-route.js.
// The token carries the storagePath, so no DB lookup is needed; the resolved path
// is still confirmed to live inside the assignment directories before opening, so a
// forged-but-somehow-valid path cannot escape.
//
// The file is STREAMED, never fully buffered — these are up to 10MB and several
// employers may pull them at once.

import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import { fileURLToPath } from 'url';
import { Router } from 'express';
import { asyncHandler } from '../../middleware/async-handler-middleware.js';
import { HttpError } from '../../middleware/error-handler-middleware.js';
import { verifyAssignmentFileToken } from '../../services/employer/assignment-signed-url-service.js';
import { isInsideAssignmentDirs } from '../../services/public/assignment-storage-service.js';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const CONTENT_TYPES = {
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.md': 'text/markdown',
};

const router = Router();

/** Strip anything that could break the Content-Disposition header. */
function sanitizeFilename(name) {
  return String(name || 'assignment-file').replace(/[^\w.\- ]/g, '_').slice(0, 128) || 'assignment-file';
}

// GET /api/public/assignment-download?token=…&filename=…
router.get('/', asyncHandler(async (req, res) => {
  const { token } = req.query;
  if (!token) throw new HttpError(400, 'Missing token', 'MISSING_TOKEN');

  let storagePath;
  try {
    ({ storagePath } = verifyAssignmentFileToken(String(token)));
  } catch (err) {
    console.warn('[assignment-download] token validation failed:', err.code || err.message);
    throw err; // HttpError(401, INVALID_TOKEN)
  }

  const absolutePath = path.resolve(BACKEND_ROOT, storagePath || '');
  if (!isInsideAssignmentDirs(absolutePath)) throw new HttpError(403, 'Forbidden', 'FORBIDDEN_PATH');

  let stat;
  try {
    stat = await fs.promises.stat(absolutePath);
  } catch {
    throw new HttpError(404, 'File missing', 'FILE_MISSING');
  }

  const extension = path.extname(absolutePath).toLowerCase();
  const downloadName = sanitizeFilename(req.query.filename || path.basename(absolutePath));

  res.setHeader('Content-Type', CONTENT_TYPES[extension] || 'application/octet-stream');
  res.setHeader('Content-Length', stat.size);
  // ALWAYS `attachment`, never `inline`. These are candidate-supplied files and we
  // are not rendering them inside the employer's browser origin.
  res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
  res.setHeader('Cache-Control', 'private, no-store');

  try {
    await pipeline(fs.createReadStream(absolutePath), res);
  } catch {
    if (!res.headersSent) throw new HttpError(404, 'File missing', 'FILE_MISSING');
  }
}));

export default router;

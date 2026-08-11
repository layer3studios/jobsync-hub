// FILE: src/api/employer/employer-import-routes.js
// Bulk candidate import onto one posting. Mounted at /api/employer/jobs behind
// requireEmployer + requireEmployerCompany (server.js); requireEmployerPosting
// tenant-verifies :postingId. Member+ only — an import writes candidate records
// into the company's pipeline.
//
// Uploads are held in memory, never staged on disk: the ZIP is read entry by entry
// and each resume's bytes go straight to resume-storage-service, so a rejected or
// failed import leaves nothing to clean up.

import { Router } from 'express';
import multer from 'multer';
import { asyncHandler } from '../../middleware/async-handler-middleware.js';
import { HttpError } from '../../middleware/error-handler-middleware.js';
import { requireEmployerPosting } from '../../middleware/require-employer-posting-middleware.js';
import { requireMemberOrHigher } from '../../middleware/require-company-role-middleware.js';
import {
  importResumesFromZip, importCandidatesFromCsv,
} from '../../services/employer/bulk-import-service.js';

const router = Router();
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

const uploadZip = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
}).single('archive');

// The CSV is required; resumes are optional and may arrive as a ZIP or as loose files.
const uploadCsv = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 202 },
}).fields([
  { name: 'csv', maxCount: 1 },
  { name: 'resumeZip', maxCount: 1 },
  { name: 'resumes', maxCount: 200 },
]);

/** Run a multer handler, translating its errors into our stable codes. */
function runUpload(handler, req, res) {
  return new Promise((resolve, reject) => {
    handler(req, res, (err) => {
      if (!err) return resolve();
      if (err instanceof HttpError) return reject(err);
      if (err.code === 'LIMIT_FILE_SIZE') {
        return reject(new HttpError(400, 'The upload must be 50MB or smaller.', 'FILE_TOO_LARGE'));
      }
      if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
        return reject(new HttpError(400, 'Too many files in this upload.', 'TOO_MANY_FILES'));
      }
      return reject(new HttpError(400, 'Could not read the uploaded file.', 'UPLOAD_FAILED'));
    });
  });
}

// POST /api/employer/jobs/:postingId/import/resumes — multipart, field `archive`.
router.post(
  '/:postingId/import/resumes',
  requireMemberOrHigher,
  requireEmployerPosting,
  asyncHandler(async (req, res) => {
    await runUpload(uploadZip, req, res);
    if (!req.file?.buffer?.length) {
      throw new HttpError(400, 'Attach a ZIP archive of PDF resumes.', 'NO_FILE');
    }
    const result = await importResumesFromZip(req.employerCompanyId, req.posting, req.file.buffer);
    res.json(result);
  }),
);

// POST /api/employer/jobs/:postingId/import/csv — multipart, field `csv`
// (+ optional `resumeZip` / `resumes`).
router.post(
  '/:postingId/import/csv',
  requireMemberOrHigher,
  requireEmployerPosting,
  asyncHandler(async (req, res) => {
    await runUpload(uploadCsv, req, res);
    const csv = req.files?.csv?.[0];
    if (!csv?.buffer?.length) throw new HttpError(400, 'Attach a CSV file.', 'NO_FILE');
    const result = await importCandidatesFromCsv(req.employerCompanyId, req.posting, csv.buffer, {
      resumeFiles: req.files?.resumes ?? [],
      resumeZip: req.files?.resumeZip?.[0] ?? null,
    });
    res.json(result);
  }),
);

export default router;

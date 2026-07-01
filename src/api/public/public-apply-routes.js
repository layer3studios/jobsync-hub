// FILE: src/api/public/public-apply-routes.js
// Public (unauthenticated) apply endpoints, mounted at /api/public. Company + job
// are looked up by slug; the apply POST is rate-limited per IP+job and per
// IP+company (R3) and takes a memory-stored PDF (never disk via multer, C8).

import { Router } from 'express';
import multer from 'multer';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { asyncHandler } from '../../middleware/async-handler-middleware.js';
import { HttpError } from '../../middleware/error-handler-middleware.js';
import { getCompanyBySlug } from '../../models/employer/company-model.js';
import {
  getActivePostingBySlugForCompany, listActivePostingsForCompany, toPublicPosting,
} from '../../models/employer/posting-model.js';
import { processApplication } from '../../services/public/apply-service.js';

const router = Router();
const HOUR = 60 * 60 * 1000;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => (file.mimetype === 'application/pdf'
    ? cb(null, true) : cb(new HttpError(400, 'Only PDF resumes are accepted.', 'INVALID_FILE_TYPE'))),
}).single('resume');

const perJobLimiter = rateLimit({
  windowMs: HOUR, limit: 10, standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => `${ipKeyGenerator(req.ip)}:${req.params.companySlug}:${req.params.jobSlug}`,
  message: { error: 'Too many applications for this job. Try again later.', code: 'RATE_LIMITED' },
});
const perCompanyLimiter = rateLimit({
  windowMs: HOUR, limit: 30, standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => `${ipKeyGenerator(req.ip)}:${req.params.companySlug}`,
  message: { error: 'Too many applications. Try again later.', code: 'RATE_LIMITED' },
});

function companySummary(company) {
  return { name: company.name, slug: company.slug, website: company.website ?? null, logoUrl: company.logoUrl ?? null };
}
function jobSummary(posting) {
  return {
    id: posting._id.toString(), slug: posting.slug, title: posting.title,
    location: posting.location, employmentType: posting.employmentType,
  };
}

/** Run multer, translating size/type errors into stable codes. */
function runUpload(req, res) {
  return new Promise((resolve, reject) => {
    upload(req, res, (err) => {
      if (!err) return resolve();
      if (err instanceof HttpError) return reject(err);
      if (err.code === 'LIMIT_FILE_SIZE') return reject(new HttpError(400, 'Resume must be 5MB or smaller.', 'FILE_TOO_LARGE'));
      return reject(new HttpError(400, 'Could not read the uploaded file.', 'UPLOAD_FAILED'));
    });
  });
}

// GET /companies/:companySlug — company info + active jobs.
router.get('/companies/:companySlug', asyncHandler(async (req, res) => {
  const company = await getCompanyBySlug(req.params.companySlug);
  if (!company) throw new HttpError(404, 'Company not found.', 'COMPANY_NOT_FOUND');
  const postings = await listActivePostingsForCompany(company._id);
  res.json({ company: companySummary(company), jobs: postings.map(jobSummary) });
}));

// GET /jobs/:companySlug/:jobSlug — active job detail.
router.get('/jobs/:companySlug/:jobSlug', asyncHandler(async (req, res) => {
  const company = await getCompanyBySlug(req.params.companySlug);
  if (!company) throw new HttpError(404, 'Company not found.', 'COMPANY_NOT_FOUND');
  const posting = await getActivePostingBySlugForCompany(company._id, req.params.jobSlug);
  if (!posting) throw new HttpError(404, 'This job is no longer accepting applications.', 'POSTING_NOT_FOUND');
  res.json({ company: companySummary(company), job: toPublicPosting(posting) });
}));

// POST /jobs/:companySlug/:jobSlug/apply — submit an application.
router.post('/jobs/:companySlug/:jobSlug/apply', perCompanyLimiter, perJobLimiter, asyncHandler(async (req, res) => {
  await runUpload(req, res);
  const resume = req.file
    ? { buffer: req.file.buffer, originalFilename: req.file.originalname, mimeType: req.file.mimetype }
    : null;
  const meta = { applicantIp: req.ip, userAgent: req.get('user-agent') || null, referer: req.get('referer') || null };
  const result = await processApplication(req.params.companySlug, req.params.jobSlug, req.body || {}, resume, meta);
  res.json(result);
}));

export default router;

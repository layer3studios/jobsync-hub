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
import {
  getAssignmentForCompany, listAssignmentsForIds,
} from '../../models/employer/assignment-model.js';
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

/**
 * THE FULL TASK IS NOT SECRET, AND MUST NOT BE GATED.
 *
 * This apply page is public and unauthenticated: anyone can open it without
 * applying, and take-home tasks circulate publicly regardless of what we do. So
 * the API returns the complete assignment — description and all — in one response.
 * Showing the summary first and the full task on click is a UX choice the frontend
 * makes; it is NOT a security boundary. Do not add a token, a "reveal" endpoint,
 * or truncation here later: it would buy nothing and would break the candidate who
 * wants to read the task before deciding to apply.
 *
 * Neither projection exposes companyId, createdByEmployerUserId, archivedAt or
 * timestamps — those are employer-side fields.
 */
function assignmentSummary(assignment) {
  // The LIST badge only: "≈4h · pdf, zip". No task text on a company page.
  return {
    estimatedHours: assignment.estimatedHours ?? null,
    allowedFileTypes: assignment.allowedFileTypes ?? [],
  };
}

function publicAssignment(assignment) {
  // The DETAIL page: everything a candidate needs to decide and to answer.
  return {
    id: assignment._id.toString(),
    title: assignment.title ?? null,
    publicSummary: assignment.publicSummary ?? null,
    descriptionMarkdown: assignment.descriptionMarkdown ?? null,
    submissionInstructionsMarkdown: assignment.submissionInstructionsMarkdown ?? null,
    estimatedHours: assignment.estimatedHours ?? null,
    allowedFileTypes: assignment.allowedFileTypes ?? [],
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

  // ONE batched query for every posting's assignment — never a lookup per job.
  // Skipped entirely when no posting carries one, so a company with no assignments
  // issues exactly the queries it did before this existed.
  const assignmentIds = [...new Set(
    postings.map((posting) => posting.assignmentId?.toString()).filter(Boolean),
  )];
  const assignments = await listAssignmentsForIds(company._id, assignmentIds);
  const assignmentById = new Map(assignments.map((assignment) => [assignment._id.toString(), assignment]));

  const jobs = postings.map((posting) => {
    const assignment = posting.assignmentId
      ? assignmentById.get(posting.assignmentId.toString()) ?? null
      : null;
    return { ...jobSummary(posting), assignment: assignment ? assignmentSummary(assignment) : null };
  });
  res.json({ company: companySummary(company), jobs });
}));

// GET /jobs/:companySlug/:jobSlug — active job detail.
router.get('/jobs/:companySlug/:jobSlug', asyncHandler(async (req, res) => {
  const company = await getCompanyBySlug(req.params.companySlug);
  if (!company) throw new HttpError(404, 'Company not found.', 'COMPANY_NOT_FOUND');
  const posting = await getActivePostingBySlugForCompany(company._id, req.params.jobSlug);
  if (!posting) throw new HttpError(404, 'This job is no longer accepting applications.', 'POSTING_NOT_FOUND');

  // The assignment rides as a SIBLING of `job`, not nested inside it —
  // toPublicPosting is shared with the employer routes and its shape stays fixed.
  let assignment = null;
  if (posting.assignmentId) {
    const found = await getAssignmentForCompany(company._id, posting.assignmentId);
    // A dangling reference is a data bug on our side, never a reason to 500 a
    // public page. Log it and render the job without its task.
    if (!found) {
      console.warn(`[apply] posting ${posting._id} references missing assignment ${posting.assignmentId}`);
    } else {
      assignment = publicAssignment(found);
    }
  }
  res.json({ company: companySummary(company), job: toPublicPosting(posting), assignment });
}));

/**
 * multipart repeats a field name for each value, so `assignmentLinks` arrives as a
 * string for one value and an array for several. The service validates every one of
 * these — nothing here is trusted, this only normalizes the shape.
 */
function normalizeAssignmentFields(body) {
  const toArray = (value) => {
    if (value === undefined || value === null || value === '') return [];
    return Array.isArray(value) ? value : [value];
  };
  return {
    ...body,
    assignmentLinks: toArray(body.assignmentLinks),
    assignmentFileIds: toArray(body.assignmentFileIds),
  };
}

// POST /jobs/:companySlug/:jobSlug/apply — submit an application.
router.post('/jobs/:companySlug/:jobSlug/apply', perCompanyLimiter, perJobLimiter, asyncHandler(async (req, res) => {
  await runUpload(req, res);
  const resume = req.file
    ? { buffer: req.file.buffer, originalFilename: req.file.originalname, mimeType: req.file.mimetype }
    : null;
  const meta = { applicantIp: req.ip, userAgent: req.get('user-agent') || null, referer: req.get('referer') || null };
  const form = normalizeAssignmentFields(req.body || {});
  const result = await processApplication(req.params.companySlug, req.params.jobSlug, form, resume, meta);
  res.json(result);
}));

export default router;

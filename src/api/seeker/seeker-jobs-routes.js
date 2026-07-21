// FILE: src/api/seeker/seeker-jobs-routes.js
import { Router } from 'express';
import { ObjectId } from 'mongodb';
import {
  getJobsPaginated, getPublicBaitJobs, findJobById,
  addCuratedJob, deleteJobById,
} from '../../Db/jobs/index.js';
import { getCompanyDirectoryStats, getCompanyIntel } from '../../Db/companies/index.js';
import { getSimilarJobs, getMarketPulse } from '../../Db/analytics/index.js';
import { asyncHandler } from '../../middleware/async-handler-middleware.js';
import { requireAdmin } from '../../middleware/require-admin-middleware.js';
import { HttpError } from '../../middleware/error-handler-middleware.js';

export const jobsApiRouter = Router();

// ─── PUBLIC ROUTES (specific paths before /:id) ────────────────────

jobsApiRouter.get('/public-bait', asyncHandler(async (_req, res) => {
  res.json(await getPublicBaitJobs());
}));

jobsApiRouter.get('/', asyncHandler(async (req, res) => {
  const page = parseInt(req.query.page, 10) || 1;
  const limit = parseInt(req.query.limit, 10) || 50;
  const company = req.query.company?.trim() || null;
  const workplace = req.query.workplace?.trim()?.toLowerCase()
    || (req.query.remote === 'true' ? 'remote' : null);
  const entryLevel = req.query.entryLevel === 'true' ? true : null;
  const roleCategory = req.query.roleCategory?.trim() || null;
  const experienceBand = req.query.experienceBand?.trim() || null;
  const techStack = typeof req.query.techStack === 'string'
    ? req.query.techStack.split(',').map(t => t.trim()).filter(Boolean)
    : [];
  const dateFilter = req.query.date?.trim() || null;
  const searchFilter = req.query.search?.trim() || null;

  const data = await getJobsPaginated(
    page, limit, company, workplace, entryLevel,
    roleCategory, experienceBand, techStack, dateFilter, searchFilter,
  );
  res.json(data);
}));

jobsApiRouter.get('/directory', asyncHandler(async (_req, res) => {
  res.json(await getCompanyDirectoryStats());
}));

jobsApiRouter.get('/market-pulse', asyncHandler(async (_req, res) => {
  res.json(await getMarketPulse());
}));

jobsApiRouter.get('/company-intel/:companyName', asyncHandler(async (req, res) => {
  res.json(await getCompanyIntel(decodeURIComponent(req.params.companyName)));
}));

jobsApiRouter.get('/similar/:jobId', asyncHandler(async (req, res) => {
  if (!ObjectId.isValid(req.params.jobId)) throw new HttpError(400, 'Invalid ID');
  res.json(await getSimilarJobs(req.params.jobId));
}));

// /:id — must come after all named GET paths
jobsApiRouter.get('/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!ObjectId.isValid(id)) throw new HttpError(400, 'Invalid ID');
  const job = await findJobById(id);
  if (!job) throw new HttpError(404, 'Job not found');
  res.json(job);
}));

// ─── ADMIN ROUTES ──────────────────────────────────────────────────

jobsApiRouter.post('/', requireAdmin, asyncHandler(async (req, res) => {
  try {
    const newJob = await addCuratedJob(req.body || {});
    res.status(201).json(newJob);
  } catch (err) {
    if (/already exists/i.test(err.message)) throw new HttpError(409, err.message);
    throw err;
  }
}));

jobsApiRouter.delete('/:id', requireAdmin, asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!ObjectId.isValid(id)) throw new HttpError(400, 'Invalid ID');
  await deleteJobById(id);
  res.json({ message: 'Job deleted.' });
}));

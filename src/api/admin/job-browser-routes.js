// FILE: src/api/admin/job-browser-routes.js
// Global job browser. Mounted at /api/admin/jobs behind requireAdmin
// (server.js), before the generic /api/admin router.
//
// DELETE refuses native postings with a 403 and a stable reason. The service
// re-checks the same thing; this is defence in depth, not the only guard.

import { Router } from 'express';
import { asyncHandler } from '../../middleware/async-handler-middleware.js';
import { HttpError } from '../../middleware/error-handler-middleware.js';
import {
  searchJobs as defaultSearchJobs,
  getJob as defaultGetJob,
  hideJob as defaultHideJob,
  unhideJob as defaultUnhideJob,
  deleteScrapedJob as defaultDeleteScrapedJob,
  listSites as defaultListSites,
} from '../../services/admin/job-browser-service.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const SOURCES = ['all', 'scraped', 'native'];
const HIDDEN_MODES = ['exclude', 'only', 'all'];

const oneOf = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);

/** "50" → 50. Anything unparseable falls back to the default; capped at 200. */
export function parseLimit(limit) {
  const parsed = parseInt(String(limit ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}

export function parseSkip(skip) {
  const parsed = parseInt(String(skip ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/** Deps are injectable so route tests need no database. */
export function createJobBrowserRouter(deps = {}) {
  const {
    searchJobs = defaultSearchJobs,
    getJob = defaultGetJob,
    hideJob = defaultHideJob,
    unhideJob = defaultUnhideJob,
    deleteScrapedJob = defaultDeleteScrapedJob,
    listSites = defaultListSites,
  } = deps;
  const router = Router();

  router.get('/', asyncHandler(async (req, res) => {
    const result = await searchJobs({
      q: req.query?.q,
      source: oneOf(req.query?.source, SOURCES, 'all'),
      site: req.query?.site ? String(req.query.site) : undefined,
      hidden: oneOf(req.query?.hidden, HIDDEN_MODES, 'exclude'),
      limit: parseLimit(req.query?.limit),
      skip: parseSkip(req.query?.skip),
    });
    res.json({ data: result });
  }));

  // Before /:id so the literal path is never swallowed by the parameter route.
  router.get('/sites', asyncHandler(async (req, res) => {
    res.json({ data: { sites: await listSites() } });
  }));

  router.get('/:id', asyncHandler(async (req, res) => {
    const job = await getJob(req.params.id);
    if (!job) throw new HttpError(404, 'Job not found', 'JOB_NOT_FOUND');
    return res.json({ data: { job } });
  }));

  const moderate = (action) => asyncHandler(async (req, res) => {
    const result = await action(req.params.id, req.adminUser?.adminUserId ?? null);
    if (!result?.ok) {
      throw new HttpError(result?.reason === 'not_found' ? 404 : 400, 'Could not update that job', result?.reason ?? 'JOB_UPDATE_FAILED');
    }
    return res.json({ data: { job: result.job } });
  });

  router.post('/:id/hide', moderate(hideJob));
  router.post('/:id/unhide', moderate(unhideJob));

  router.delete('/:id', asyncHandler(async (req, res) => {
    const result = await deleteScrapedJob(req.params.id, req.adminUser?.adminUserId ?? null);
    if (result.deleted) return res.json({ data: result });
    // A native posting is a refusal, not a missing record.
    const status = result.reason === 'native_posting' ? 403 : 404;
    return res.status(status).json({
      error: result.reason === 'native_posting'
        ? 'Employer postings cannot be deleted from the admin panel'
        : 'Job not found',
      code: result.reason,
      data: result,
    });
  }));

  return router;
}

export default createJobBrowserRouter;

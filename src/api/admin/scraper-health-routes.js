// FILE: src/api/admin/scraper-health-routes.js
// Scraper Health dashboard. Mounted at /api/admin/scraper-health behind
// requireAdmin (server.js), before the generic /api/admin router.
//
// POST /run-now deliberately does NOT await runScraper(): a full pass takes
// minutes and the caller only needs to know the trigger landed. The scrape's
// own isScraping lock is the source of truth for "already running".

import { Router } from 'express';
import { asyncHandler } from '../../middleware/async-handler-middleware.js';
import {
  listRecentRuns as defaultListRecentRuns,
  getSiteSummaries as defaultGetSiteSummaries,
  getCorpusQuality as defaultGetCorpusQuality,
} from '../../services/admin/scraper-health-service.js';
import { runScraper as defaultRunScraper, isScraperRunning as defaultIsScraperRunning } from '../../tasks/runScraper.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** "25" → 25. Anything unparseable falls back to the default; capped at 200. */
export function parseLimit(limit) {
  const parsed = parseInt(String(limit ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}

/** Deps are injectable so route tests need neither a database nor a real scrape. */
export function createScraperHealthRouter(deps = {}) {
  const {
    listRecentRuns = defaultListRecentRuns,
    getSiteSummaries = defaultGetSiteSummaries,
    getCorpusQuality = defaultGetCorpusQuality,
    runScraper = defaultRunScraper,
    isScraperRunning = defaultIsScraperRunning,
  } = deps;
  const router = Router();

  router.get('/', asyncHandler(async (req, res) => {
    const [sites, corpus] = await Promise.all([getSiteSummaries(), getCorpusQuality()]);
    res.json({ data: { sites, corpus } });
  }));

  router.get('/runs', asyncHandler(async (req, res) => {
    const siteName = req.query?.site ? String(req.query.site) : undefined;
    const runs = await listRecentRuns({ siteName, limit: parseLimit(req.query?.limit) });
    res.json({ data: { runs } });
  }));

  router.post('/run-now', asyncHandler(async (req, res) => {
    if (isScraperRunning()) {
      return res.json({ data: { started: false, reason: 'already_running' } });
    }
    // Fire and forget: the pass outlives this request by minutes.
    Promise.resolve()
      .then(() => runScraper())
      .catch((err) => console.error('[scraper-health] run-now failed:', err));
    return res.json({ data: { started: true } });
  }));

  return router;
}

export default createScraperHealthRouter;

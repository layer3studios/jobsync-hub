// FILE: src/api/admin/admin-ai-usage-routes.js
// GET /api/admin/ai-usage?range=7d — AI spend for the admin dashboard.
// Mounted behind requireAdmin (server.js).
//
// Two sources, deliberately: byDay/byModel/byTier come from MongoDB (the
// HISTORICAL record, survives restarts), while currentLimits reads the live
// in-memory RateLimitTracker (what is spendable RIGHT NOW). Neither can
// substitute for the other.

import { Router } from 'express';
import { asyncHandler } from '../../middleware/async-handler-middleware.js';
import { listUsageStats as defaultListStats } from '../../gemma/usage-stats.js';
import { getAiUsageSnapshot as defaultGetSnapshot } from '../../gemma/gemma-runtime.js';
import { buildUsageReport } from '../../services/admin/ai-usage-service.js';

const DEFAULT_RANGE_DAYS = 7;
const MAX_RANGE_DAYS = 90;

/** "30d" → 30. Anything unparseable falls back to the default; capped at 90. */
export function parseRangeDays(range) {
  const parsed = parseInt(String(range ?? '').replace(/d$/i, ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_RANGE_DAYS;
  return Math.min(parsed, MAX_RANGE_DAYS);
}

/** Deps are injectable so route tests need neither a live tracker nor real stats. */
export function createAdminAiUsageRouter(deps = {}) {
  const {
    listUsageStats = defaultListStats,
    getAiUsageSnapshot = defaultGetSnapshot,
  } = deps;
  const router = Router();

  router.get('/', asyncHandler(async (req, res) => {
    const days = parseRangeDays(req.query?.range);
    const docs = await listUsageStats(days);
    const currentLimits = getAiUsageSnapshot() ?? { models: [] };
    res.json({ data: { ...buildUsageReport(docs, currentLimits), rangeDays: days } });
  }));

  return router;
}

export default createAdminAiUsageRouter;

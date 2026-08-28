// FILE: src/api/admin/mission-control-routes.js
// GET /api/admin/overview — totals, week-over-week movement and the live system
// strip for the admin home page. Mounted behind requireAdmin (server.js),
// before the generic /api/admin router. Read-only.
//
// Overview and status are fetched together but independently: a failing status
// component must not cost the page its numbers.

import { Router } from 'express';
import { asyncHandler } from '../../middleware/async-handler-middleware.js';
import {
  getOverview as defaultGetOverview,
  getSystemStatus as defaultGetSystemStatus,
} from '../../services/admin/mission-control-service.js';

/** Deps are injectable so route tests need neither a database nor live workers. */
export function createMissionControlRouter(deps = {}) {
  const {
    getOverview = defaultGetOverview,
    getSystemStatus = defaultGetSystemStatus,
  } = deps;
  const router = Router();

  router.get('/', asyncHandler(async (req, res) => {
    const [overview, status] = await Promise.all([getOverview(), getSystemStatus()]);
    res.json({ data: { overview, status } });
  }));

  return router;
}

export default createMissionControlRouter;

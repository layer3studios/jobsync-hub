// FILE: src/api/admin/company-health-routes.js
// GET /api/admin/companies-health — one row per company for the admin table.
// Mounted behind requireAdmin (server.js), before the generic /api/admin router.
// Read-only: this router performs no writes.

import { Router } from 'express';
import { asyncHandler } from '../../middleware/async-handler-middleware.js';
import { listCompanyHealth as defaultListCompanyHealth } from '../../services/admin/company-health-service.js';

/** Deps are injectable so route tests need no database. */
export function createCompanyHealthRouter(deps = {}) {
  const { listCompanyHealth = defaultListCompanyHealth } = deps;
  const router = Router();

  router.get('/', asyncHandler(async (req, res) => {
    res.json({ data: { companies: await listCompanyHealth() } });
  }));

  return router;
}

export default createCompanyHealthRouter;

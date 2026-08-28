// FILE: src/api/admin/feature-flags-routes.js
// GET/PATCH /api/admin/feature-flags — the runtime kill switches. Mounted
// behind requireAdmin (server.js), before the generic /api/admin router.
//
// PATCH takes one flag at a time ({ name, value }) rather than a whole object:
// turning the product's features off is a deliberate act, and a per-flag write
// keeps the audit trail one row per decision.

import { Router } from 'express';
import { asyncHandler } from '../../middleware/async-handler-middleware.js';
import { HttpError } from '../../middleware/error-handler-middleware.js';
import {
  getFeatureFlags as defaultGetFeatureFlags,
  setFeatureFlag as defaultSetFeatureFlag,
  FEATURE_FLAG_NAMES,
} from '../../models/admin/feature-flags-model.js';

/** Deps are injectable so route tests need no database. */
export function createFeatureFlagsRouter(deps = {}) {
  const {
    getFeatureFlags = defaultGetFeatureFlags,
    setFeatureFlag = defaultSetFeatureFlag,
  } = deps;
  const router = Router();

  router.get('/', asyncHandler(async (req, res) => {
    const state = await getFeatureFlags();
    res.json({ data: { ...state, names: FEATURE_FLAG_NAMES } });
  }));

  router.patch('/', asyncHandler(async (req, res) => {
    const { name, value } = req.body || {};
    if (typeof name !== 'string' || !FEATURE_FLAG_NAMES.includes(name)) {
      throw new HttpError(400, 'Unknown feature flag', 'UNKNOWN_FLAG');
    }
    if (typeof value !== 'boolean') {
      throw new HttpError(400, 'value must be a boolean', 'INVALID_FLAG_VALUE');
    }

    const result = await setFeatureFlag(name, value, req.adminUser?.adminUserId ?? null);
    if (!result?.ok) {
      throw new HttpError(400, 'Could not update that flag', result?.reason ?? 'FLAG_UPDATE_FAILED');
    }
    return res.json({
      data: {
        flags: result.flags,
        updatedAt: result.updatedAt,
        updatedByAdminUserId: result.updatedByAdminUserId,
        names: FEATURE_FLAG_NAMES,
      },
    });
  }));

  return router;
}

export default createFeatureFlagsRouter;

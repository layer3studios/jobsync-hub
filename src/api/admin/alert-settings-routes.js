// FILE: src/api/admin/alert-settings-routes.js
// GET/PATCH /api/admin/alerts plus POST /api/admin/alerts/test-digest.
// Mounted behind requireAdmin (server.js), before the generic /api/admin router.
//
// test-digest sends a REAL email to the configured recipients — it is the only
// way to prove the whole path works, and a digest nobody can trigger is a
// digest nobody trusts. It is awaited so the caller learns whether it landed.

import { Router } from 'express';
import { asyncHandler } from '../../middleware/async-handler-middleware.js';
import { HttpError } from '../../middleware/error-handler-middleware.js';
import {
  getAlertSettings as defaultGetAlertSettings,
  setAlertSettings as defaultSetAlertSettings,
} from '../../models/admin/alert-settings-model.js';
import { sendWeeklyDigest as defaultSendWeeklyDigest } from '../../services/admin/weekly-digest-service.js';

/** Deps are injectable so route tests need neither a database nor a mail server. */
export function createAlertSettingsRouter(deps = {}) {
  const {
    getAlertSettings = defaultGetAlertSettings,
    setAlertSettings = defaultSetAlertSettings,
    sendWeeklyDigest = defaultSendWeeklyDigest,
  } = deps;
  const router = Router();

  router.get('/', asyncHandler(async (req, res) => {
    res.json({ data: { settings: await getAlertSettings() } });
  }));

  router.patch('/', asyncHandler(async (req, res) => {
    const result = await setAlertSettings(req.body || {}, req.adminUser?.adminUserId ?? null);
    if (!result.ok) throw new HttpError(400, 'Invalid alert settings', result.reason);
    return res.json({ data: { settings: result.settings } });
  }));

  router.post('/test-digest', asyncHandler(async (req, res) => {
    const result = await sendWeeklyDigest();
    return res.json({ data: result });
  }));

  return router;
}

export default createAlertSettingsRouter;

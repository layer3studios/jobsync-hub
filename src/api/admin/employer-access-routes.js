// FILE: src/api/admin/employer-access-routes.js
// Admin endpoints for the employer signup gate: read state, flip the global
// toggle, and manage the email whitelist. Mounted under /api/admin behind
// requireAdmin (jm_admin_token, applied by the parent admin router).

import { Router } from 'express';
import {
  getEmployerAccessConfig,
  setEmployerSignupOpen,
  listEmployerAccessWhitelist,
  addEmployerAccessWhitelistEntry,
  removeEmployerAccessWhitelistEntry,
} from '../../models/employer/index.js';
import { asyncHandler } from '../../middleware/async-handler-middleware.js';
import { HttpError } from '../../middleware/error-handler-middleware.js';
import { appendAudit } from '../../services/dpdp/audit-log-service.js';
import { AUDIT_EVENTS } from '../../models/dpdp/dpdp-constants.js';

const router = Router();

const MAXIMUM_EMAIL_LENGTH = 254;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function toPublicWhitelistEntry(entry) {
  return { email: entry.email, note: entry.note ?? null, addedAt: entry.addedAt };
}

// GET /api/admin/employer-access
router.get('/employer-access', asyncHandler(async (_req, res) => {
  const config = await getEmployerAccessConfig();
  const whitelist = await listEmployerAccessWhitelist();
  res.json({
    data: {
      isEmployerSignupOpen: config.isEmployerSignupOpen,
      whitelist: whitelist.map(toPublicWhitelistEntry),
    },
  });
}));

// POST /api/admin/employer-access/toggle
router.post('/employer-access/toggle', asyncHandler(async (req, res) => {
  const { isEmployerSignupOpen } = req.body || {};
  if (typeof isEmployerSignupOpen !== 'boolean') {
    throw new HttpError(400, 'isEmployerSignupOpen must be a boolean', 'INVALID_TOGGLE_VALUE');
  }
  const result = await setEmployerSignupOpen(isEmployerSignupOpen, req.user?.userId || null);
  // audit: employer_signup_toggled — who opened or closed employer signup.
  await appendAudit({
    event: AUDIT_EVENTS.EMPLOYER_SIGNUP_TOGGLED,
    actorType: 'admin', actorId: req.adminUser?.adminUserId ?? null,
    targetType: 'employer_access_config', targetId: null,
    metadata: { isEmployerSignupOpen },
  });
  res.json({ data: result });
}));

// POST /api/admin/employer-access/whitelist
router.post('/employer-access/whitelist', asyncHandler(async (req, res) => {
  const rawEmail = req.body?.email;
  const note = req.body?.note;
  if (typeof rawEmail !== 'string') {
    throw new HttpError(400, 'email is required', 'INVALID_EMAIL');
  }
  const email = rawEmail.trim().toLowerCase();
  if (!email || email.length > MAXIMUM_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) {
    throw new HttpError(400, 'A valid email is required', 'INVALID_EMAIL');
  }
  if (note !== undefined && typeof note !== 'string') {
    throw new HttpError(400, 'note must be a string', 'INVALID_NOTE');
  }

  const entry = await addEmployerAccessWhitelistEntry(email, note, req.user?.userId || null);
  // audit: whitelist_entry_added. targetId stays null — the audit model casts
  // targetId to an ObjectId and a whitelist row is keyed by email, so the
  // identifier belongs in metadata.
  await appendAudit({
    event: AUDIT_EVENTS.WHITELIST_ENTRY_ADDED,
    actorType: 'admin', actorId: req.adminUser?.adminUserId ?? null,
    targetType: 'employer_access_whitelist', targetId: null,
    metadata: { email },
  });
  res.json({ data: toPublicWhitelistEntry(entry) });
}));

// DELETE /api/admin/employer-access/whitelist/:email
router.delete('/employer-access/whitelist/:email', asyncHandler(async (req, res) => {
  const email = decodeURIComponent(req.params.email || '').trim().toLowerCase();
  await removeEmployerAccessWhitelistEntry(email);
  // audit: whitelist_entry_removed — see the note on the add path above.
  await appendAudit({
    event: AUDIT_EVENTS.WHITELIST_ENTRY_REMOVED,
    actorType: 'admin', actorId: req.adminUser?.adminUserId ?? null,
    targetType: 'employer_access_whitelist', targetId: null,
    metadata: { email },
  });
  res.json({ data: { deleted: true } });
}));

export default router;

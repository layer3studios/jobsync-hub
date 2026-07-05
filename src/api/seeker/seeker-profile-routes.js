// FILE: src/api/seeker/seeker-profile-routes.js
// Seeker profile read/edit, mounted at /api/seeker/profile behind requireSeeker
// (server.js). GET returns the parsedProfile (or null); PATCH edits a whitelist of
// top-level fields without a re-upload. Identity is always req.user.userId (§6.5).

import { Router } from 'express';
import { asyncHandler } from '../../middleware/async-handler-middleware.js';
import { HttpError } from '../../middleware/error-handler-middleware.js';
import {
  getProfileEnvelopeForUser, patchProfileForUser, PATCHABLE_PROFILE_FIELDS,
} from '../../models/seeker/seeker-profile-helpers.js';

const router = Router();

// GET / — the caller's parsed profile plus display metadata (FIX-01 B2). The
// top-level `profile` key is unchanged (additive); `meta` carries the timestamps
// + hasResumeOnFile hint that F3c's stale badge reads.
router.get('/', asyncHandler(async (req, res) => {
  res.json(await getProfileEnvelopeForUser(req.user.userId));
}));

// PATCH / — edit whitelisted profile fields.
router.patch('/', asyncHandler(async (req, res) => {
  const body = req.body || {};
  const patch = {};
  for (const key of Object.keys(body)) {
    if (!PATCHABLE_PROFILE_FIELDS.includes(key)) {
      throw new HttpError(400, `Unknown field: ${key}`, 'UNKNOWN_FIELD');
    }
    patch[key] = body[key];
  }
  if (Object.keys(patch).length === 0) {
    throw new HttpError(400, 'No valid fields to update.', 'EMPTY_PATCH');
  }
  const profile = await patchProfileForUser(req.user.userId, patch);
  res.json({ profile });
}));

export default router;

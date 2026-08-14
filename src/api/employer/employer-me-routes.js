// FILE: src/api/employer/employer-me-routes.js
// The signed-in employer's OWN settings: timezone, job title, avatar, notification
// preferences. Mounted at /api/employer/me behind requireEmployer only — NOT behind
// requireEmployerCompany, because these are personal to the user and a teammate
// mid-onboarding still has a timezone.
//
// NO ROLE GATES ANYWHERE IN THIS FILE. Every route reads and writes exactly one row:
// the caller's own, resolved from the session and never from input. An Interviewer
// editing their own job title is not a permission question.

import { Router } from 'express';
import multer from 'multer';
import { asyncHandler } from '../../middleware/async-handler-middleware.js';
import { HttpError } from '../../middleware/error-handler-middleware.js';
import { getEmployerUserById } from '../../models/employer/employer-user-model.js';
import {
  updateEmployerUserProfile, mergeNotificationPreferences,
} from '../../models/employer/employer-user-profile-model.js';
import {
  validateTimezone, validateJobTitle, validateNotificationPatch,
} from '../../services/employer/personal-settings-validators.js';
import {
  storeAvatarFile, deleteAvatarFile, publicAvatarUrlFor,
  MAXIMUM_AVATAR_BYTES, ALLOWED_AVATAR_MIME_TYPES,
} from '../../services/employer/avatar-storage-service.js';
import { invalidateNotificationCache } from '../../services/employer/notification-gate-service.js';
import { toPublicEmployerUser } from './employer-user-projection.js';

const router = Router();
const PATCHABLE_FIELDS = ['timezone', 'jobTitle'];

// Memory storage, never disk: the buffer is type- and size-checked before
// avatar-storage-service writes anything, so a rejected upload leaves no bytes.
const uploadAvatar = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAXIMUM_AVATAR_BYTES },
  fileFilter: (_req, file, cb) => (ALLOWED_AVATAR_MIME_TYPES.includes(file.mimetype)
    ? cb(null, true)
    : cb(new HttpError(400, 'Photo must be a PNG, JPG or WebP image.', 'INVALID_FILE_TYPE'))),
}).single('avatar');

/** Run multer, translating its size/type errors into our stable codes. */
function runAvatarUpload(req, res) {
  return new Promise((resolve, reject) => {
    uploadAvatar(req, res, (err) => {
      if (!err) return resolve();
      if (err instanceof HttpError) return reject(err);
      if (err.code === 'LIMIT_FILE_SIZE') {
        return reject(new HttpError(400, 'Photo must be 2MB or smaller.', 'FILE_TOO_LARGE'));
      }
      return reject(new HttpError(400, 'Could not read the uploaded file.', 'UPLOAD_FAILED'));
    });
  });
}

/** The caller's own row, or 401 — a valid cookie for a deleted user is no session. */
async function requireSelf(req) {
  const user = await getEmployerUserById(req.employerUser.employerUserId);
  if (!user) throw new HttpError(401, 'Unauthorized', 'USER_NOT_FOUND');
  return user;
}

// GET /api/employer/me — the caller's settings.
router.get('/', asyncHandler(async (req, res) => {
  const user = await requireSelf(req);
  res.json({ employerUser: toPublicEmployerUser(user) });
}));

// PATCH /api/employer/me — { timezone?, jobTitle? }. Unknown keys are refused
// rather than ignored: name/email/picture come from Google and are not editable
// here, and a silent drop would look like a save that did not stick.
router.patch('/', asyncHandler(async (req, res) => {
  const body = req.body || {};
  for (const key of Object.keys(body)) {
    if (!PATCHABLE_FIELDS.includes(key)) {
      throw new HttpError(400, `Unknown field: ${key}`, 'UNKNOWN_FIELD');
    }
  }
  const patch = {};
  if ('timezone' in body) patch.timezone = validateTimezone(body.timezone);
  if ('jobTitle' in body) patch.jobTitle = validateJobTitle(body.jobTitle);
  if (Object.keys(patch).length === 0) throw new HttpError(400, 'Nothing to update.', 'EMPTY_PATCH');

  const updated = await updateEmployerUserProfile(req.employerUser.employerUserId, patch);
  if (!updated) throw new HttpError(401, 'Unauthorized', 'USER_NOT_FOUND');
  res.json({ employerUser: toPublicEmployerUser(updated) });
}));

// PATCH /api/employer/me/notifications — a PARTIAL preferences object, merged.
router.patch('/notifications', asyncHandler(async (req, res) => {
  const patch = validateNotificationPatch(req.body);
  const updated = await mergeNotificationPreferences(req.employerUser.employerUserId, patch);
  if (!updated) throw new HttpError(401, 'Unauthorized', 'USER_NOT_FOUND');
  // The gate caches preferences for 30s. Without this, a user could turn something
  // off and still receive it for half a minute — which reads as the switch failing.
  invalidateNotificationCache(req.employerUser.employerUserId);
  res.json({ employerUser: toPublicEmployerUser(updated) });
}));

// POST /api/employer/me/avatar — upload or replace the caller's photo.
router.post('/avatar', asyncHandler(async (req, res) => {
  await runAvatarUpload(req, res);
  const user = await requireSelf(req);
  if (!req.file?.buffer) throw new HttpError(400, 'An image file is required.', 'NO_FILE');

  const stored = storeAvatarFile(req.file.buffer, req.file.mimetype);
  const updated = await updateEmployerUserProfile(user._id, {
    avatarUrl: publicAvatarUrlFor(user._id),
    avatarStoragePath: stored.storagePath,
  });
  if (!updated) {
    deleteAvatarFile(stored.storagePath); // nothing references these bytes
    throw new HttpError(401, 'Unauthorized', 'USER_NOT_FOUND');
  }
  // Replacing retires the old file, and only AFTER the row points at the new one:
  // an orphaned file is recoverable, a row pointing at a deleted file is a broken
  // <img> on a page a candidate might be looking at.
  if (user.avatarStoragePath) deleteAvatarFile(user.avatarStoragePath);
  res.json({ avatarUrl: updated.avatarUrl, employerUser: toPublicEmployerUser(updated) });
}));

// DELETE /api/employer/me/avatar — clear the upload and fall back to Google's photo.
router.delete('/avatar', asyncHandler(async (req, res) => {
  const user = await requireSelf(req);
  const updated = await updateEmployerUserProfile(user._id, {
    avatarUrl: null, avatarStoragePath: null,
  });
  if (updated && user.avatarStoragePath) deleteAvatarFile(user.avatarStoragePath);
  res.json({ employerUser: toPublicEmployerUser(updated ?? user) });
}));

export default router;

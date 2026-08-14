// FILE: src/api/public/employer-avatar-route.js
// Public (unauthenticated) employer-avatar read, mounted at /api/public/avatar.
// Mirrors company-logo-route exactly.
//
// Public because the candidate-facing surfaces need it: an interview booking page
// shows who the candidate will be meeting, and that page has no session to
// authenticate against. It serves ONE thing — bytes previously uploaded through the
// self-only employer route, from data/avatars/ only. The path comes from the user
// row (never from the URL) and is re-checked for directory containment before any
// read, so this can never be walked into an arbitrary-file reader.

import { Router } from 'express';
import { asyncHandler } from '../../middleware/async-handler-middleware.js';
import { HttpError } from '../../middleware/error-handler-middleware.js';
import { getEmployerUserById } from '../../models/employer/employer-user-model.js';
import { readAvatarFile, contentTypeForAvatar } from '../../services/employer/avatar-storage-service.js';

const router = Router();
const CACHE_CONTROL = 'public, max-age=3600';

// GET /api/public/avatar/:employerUserId — stream one employer user's photo.
router.get('/:employerUserId', asyncHandler(async (req, res) => {
  const user = await getEmployerUserById(req.params.employerUserId);
  // A bad id and a user with no uploaded photo are the same thing to a caller: no
  // image. 404 rather than a placeholder — the client falls back to its initials.
  if (!user?.avatarStoragePath) throw new HttpError(404, 'No avatar', 'AVATAR_NOT_FOUND');

  const contentType = contentTypeForAvatar(user.avatarStoragePath);
  const buffer = contentType ? readAvatarFile(user.avatarStoragePath) : null;
  // The row says there is a photo but the bytes are gone (deleted by hand). Not a
  // 500 — the <img> onError handler falls back to initials.
  if (!buffer) throw new HttpError(404, 'No avatar', 'AVATAR_NOT_FOUND');

  res.set('Content-Type', contentType);
  res.set('Cache-Control', CACHE_CONTROL);
  res.set('Content-Length', String(buffer.length));
  res.send(buffer);
}));

export default router;

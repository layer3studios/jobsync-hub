// FILE: src/services/employer/avatar-storage-service.js
// Local-disk avatar storage for employer users, mirroring logo-storage-service:
// bytes go to {backendRoot}/data/avatars/{uuid}.{ext} under a random filename and
// the DB stores the relative path only.
//
// Avatars ARE served publicly, like logos and unlike resumes — a candidate booking
// an interview sees who they are meeting, and that page has no session. As with
// logos, public means "through one dedicated read route", never a static directory.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { HttpError } from '../../middleware/error-handler-middleware.js';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const AVATAR_DIR = path.join(BACKEND_ROOT, 'data', 'avatars');
const AVATAR_REL = path.posix.join('data', 'avatars');

export const MAXIMUM_AVATAR_BYTES = 2 * 1024 * 1024;

// Extension comes from the mime type, never the uploaded filename — the filename is
// attacker-controlled and is not stored at all.
const EXTENSION_BY_MIME = Object.freeze({
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
});

export const ALLOWED_AVATAR_MIME_TYPES = Object.freeze(Object.keys(EXTENSION_BY_MIME));

const MIME_BY_EXTENSION = Object.freeze({ png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' });

/**
 * The PUBLIC read URL stored in employerUser.avatarUrl.
 *
 * Keyed by employerUserId, like the logo route is keyed by companyId: the surfaces
 * that render an avatar (a note author, an interview panel on a candidate-facing
 * page) have no employer session to resolve "me" against.
 */
export function publicAvatarUrlFor(employerUserId) {
  return `/api/public/avatar/${String(employerUserId)}`;
}

/** Create data/avatars/ if missing. Called on boot and before every write. */
export function ensureAvatarDirectory() {
  fs.mkdirSync(AVATAR_DIR, { recursive: true });
}

/**
 * Validate then write an avatar buffer. Validation happens BEFORE any disk write, so
 * a rejected upload never leaves bytes behind. Throws HttpError with a stable code.
 */
export function storeAvatarFile(buffer, mimeType) {
  if (!buffer || buffer.length === 0) {
    throw new HttpError(400, 'An image file is required.', 'NO_FILE');
  }
  const extension = EXTENSION_BY_MIME[mimeType];
  if (!extension) {
    throw new HttpError(400, 'Photo must be a PNG, JPG or WebP image.', 'INVALID_FILE_TYPE');
  }
  if (buffer.length > MAXIMUM_AVATAR_BYTES) {
    throw new HttpError(400, 'Photo must be 2MB or smaller.', 'FILE_TOO_LARGE');
  }

  ensureAvatarDirectory();
  const filename = `${crypto.randomUUID()}.${extension}`;
  fs.writeFileSync(path.join(AVATAR_DIR, filename), buffer);
  return { storagePath: path.posix.join(AVATAR_REL, filename), sizeBytes: buffer.length };
}

/**
 * True when a stored path really points inside data/avatars/. The stored value is
 * ours, but this containment check is what keeps a corrupted or hand-edited row from
 * turning the public read route into an arbitrary-file reader.
 */
export function isInsideAvatarDirectory(storagePath) {
  if (typeof storagePath !== 'string' || !storagePath) return false;
  const absolute = path.resolve(BACKEND_ROOT, storagePath);
  const root = path.resolve(AVATAR_DIR);
  return absolute === root || absolute.startsWith(root + path.sep);
}

/** Content-Type for a stored avatar path, or null when the extension is unknown. */
export function contentTypeForAvatar(storagePath) {
  const extension = path.extname(String(storagePath ?? '')).replace('.', '').toLowerCase();
  return MIME_BY_EXTENSION[extension] ?? null;
}

/** Read a stored avatar's bytes. Returns null when missing or out of bounds. */
export function readAvatarFile(storagePath) {
  if (!isInsideAvatarDirectory(storagePath)) return null;
  try {
    return fs.readFileSync(path.resolve(BACKEND_ROOT, storagePath));
  } catch {
    return null; // deleted by hand — the caller falls back to initials
  }
}

/** Best-effort delete, used when an avatar is replaced or cleared. */
export function deleteAvatarFile(storagePath) {
  if (!isInsideAvatarDirectory(storagePath)) return;
  try {
    fs.unlinkSync(path.resolve(BACKEND_ROOT, storagePath));
  } catch { /* already gone — nothing to clean up */ }
}

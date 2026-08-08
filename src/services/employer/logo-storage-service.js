// FILE: src/services/employer/logo-storage-service.js
// Local-disk company-logo storage, mirroring resume-storage-service.js: bytes are
// written to {backendRoot}/data/logos/{uuid}.{ext} under a random filename and the
// DB stores the relative path only. Unlike resumes, logos ARE served publicly —
// the careers page needs them — but only through the dedicated read route, never
// as a static directory.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { HttpError } from '../../middleware/error-handler-middleware.js';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const LOGO_DIR = path.join(BACKEND_ROOT, 'data', 'logos');
const LOGO_REL = path.posix.join('data', 'logos');

export const MAXIMUM_LOGO_BYTES = 2 * 1024 * 1024;

// Extension is derived from the mime type, never from the uploaded filename — the
// filename is attacker-controlled and is not stored at all.
const EXTENSION_BY_MIME = Object.freeze({
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
});

export const ALLOWED_LOGO_MIME_TYPES = Object.freeze(Object.keys(EXTENSION_BY_MIME));

/** Content-Type to serve a stored logo back with, derived from its extension. */
const MIME_BY_EXTENSION = Object.freeze({
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
});

/**
 * The PUBLIC read URL for a company's logo — what gets stored in company.logoUrl
 * and rendered as an <img src> by the unauthenticated careers page.
 *
 * Keyed by companyId, NOT by "current": the employer-scoped route this feature was
 * first sketched against resolves the company from the session, and the careers
 * page has no session, so a session-relative URL could never render there. Keyed by
 * id rather than slug so the URL survives a slug change.
 */
export function publicLogoUrlFor(companyId) {
  return `/api/public/company-logo/${String(companyId)}`;
}

/** Create data/logos/ if missing. Called on boot and before every write. */
export function ensureLogoDirectory() {
  fs.mkdirSync(LOGO_DIR, { recursive: true });
}

/**
 * Validate then write a logo buffer. Validation happens BEFORE any disk write so a
 * rejected upload never leaves bytes behind. Throws HttpError with a stable code.
 */
export function storeLogoFile(buffer, mimeType) {
  if (!buffer || buffer.length === 0) {
    throw new HttpError(400, 'A logo file is required.', 'NO_FILE');
  }
  const extension = EXTENSION_BY_MIME[mimeType];
  if (!extension) {
    throw new HttpError(400, 'Logo must be a PNG, JPG or WebP image.', 'INVALID_FILE_TYPE');
  }
  if (buffer.length > MAXIMUM_LOGO_BYTES) {
    throw new HttpError(400, 'Logo must be 2MB or smaller.', 'FILE_TOO_LARGE');
  }

  ensureLogoDirectory();
  const filename = `${crypto.randomUUID()}.${extension}`;
  fs.writeFileSync(path.join(LOGO_DIR, filename), buffer);
  return { storagePath: path.posix.join(LOGO_REL, filename), sizeBytes: buffer.length };
}

/**
 * True when a stored path really points inside data/logos/. The stored value is
 * ours, but this is the containment check that keeps a corrupted or hand-edited
 * row from turning the read route into an arbitrary-file reader.
 */
export function isInsideLogoDirectory(storagePath) {
  if (typeof storagePath !== 'string' || !storagePath) return false;
  const absolute = path.resolve(BACKEND_ROOT, storagePath);
  const root = path.resolve(LOGO_DIR);
  return absolute === root || absolute.startsWith(root + path.sep);
}

/** Content-Type for a stored logo path, or null when the extension is unknown. */
export function contentTypeForLogo(storagePath) {
  const extension = path.extname(String(storagePath ?? '')).replace('.', '').toLowerCase();
  return MIME_BY_EXTENSION[extension] ?? null;
}

/** Read a stored logo's bytes. Returns null when missing or out of bounds. */
export function readLogoFile(storagePath) {
  if (!isInsideLogoDirectory(storagePath)) return null;
  try {
    return fs.readFileSync(path.resolve(BACKEND_ROOT, storagePath));
  } catch {
    return null; // deleted by hand — the caller falls back to initials
  }
}

/** Best-effort delete, used when a logo is replaced or cleared. */
export function deleteLogoFile(storagePath) {
  if (!isInsideLogoDirectory(storagePath)) return;
  try {
    fs.unlinkSync(path.resolve(BACKEND_ROOT, storagePath));
  } catch { /* already gone — nothing to clean up */ }
}

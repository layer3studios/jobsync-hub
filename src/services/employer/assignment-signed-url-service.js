// FILE: src/services/employer/assignment-signed-url-service.js
// HMAC-signed, database-free tokens for assignment files. Two kinds, same crypto,
// different payloads and lifetimes:
//
//   DOWNLOAD token — grants an employer 15 minutes of read access to one stored
//   file. Payload is the storagePath, so the download route needs no DB lookup.
//
//   STAGED FILE token (the `fileId` handed to the seeker on upload) — carries
//   everything the apply endpoint needs to commit the file: where it is on disk and
//   the display metadata. That is why fileId is a signed token and not a bare uuid:
//   a guessed uuid cannot be attached to someone else's application, and 4b needs
//   neither a DB row nor a sidecar file to resolve one.
//
// Signature is HMAC-SHA256 over `{payload}.{expiresAt}`; the whole
// `{payload}.{expiresAt}.{signature}` string is base64url-encoded into an opaque
// token. Compare is constant-time. Pure module: no I/O. `secret` is injectable so
// tests can exercise the wrong-secret path.

import crypto from 'crypto';
import { ASSIGNMENT_URL_SECRET } from '../../env.js';
import { HttpError } from '../../middleware/error-handler-middleware.js';
import { STAGING_TTL_MS } from '../public/assignment-storage-service.js';

export const ASSIGNMENT_FILE_TTL_MS = 15 * 60 * 1000; // 15 minutes

function computeSignature(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

/** Constant-time signature check. Length is compared first — timingSafeEqual throws on a mismatch. */
function signatureMatches(payload, signature, secret) {
  const expected = computeSignature(payload, secret);
  const signatureBuffer = Buffer.from(String(signature || ''));
  const expectedBuffer = Buffer.from(expected);
  return signatureBuffer.length === expectedBuffer.length
    && crypto.timingSafeEqual(signatureBuffer, expectedBuffer);
}

/**
 * Split and validate a token's envelope. Returns the payload string, or throws the
 * caller's error for ANY failure — malformed, tampered, wrong secret — so no code
 * path reveals which check failed. Expiry is reported separately via `expired` so
 * the staged-token path can distinguish it; the download path does not.
 */
function openToken(token, secret) {
  const decoded = Buffer.from(String(token || ''), 'base64url').toString('utf8');
  const separator = decoded.lastIndexOf('.');
  if (separator < 0) return { ok: false };
  const signature = decoded.slice(separator + 1);
  const signed = decoded.slice(0, separator);

  const expirySeparator = signed.lastIndexOf('.');
  if (expirySeparator < 0) return { ok: false };
  const expiresAtRaw = signed.slice(expirySeparator + 1);
  const payload = signed.slice(0, expirySeparator);

  const expiresAt = Number(expiresAtRaw);
  if (!Number.isFinite(expiresAt)) return { ok: false };
  // Signature is verified BEFORE expiry is reported, so an attacker cannot forge a
  // token and learn "expired" (which would confirm the rest of it parsed).
  if (!signatureMatches(signed, signature, secret)) return { ok: false };
  // `>=`, not `>`: a token whose expiry is exactly now is dead. signResumeToken uses
  // `>`, which leaves a zero-TTL token valid for one millisecond — harmless there,
  // but there is no reading of "expires at T" under which T itself still grants access.
  if (Date.now() >= expiresAt) return { ok: false, expired: true };
  return { ok: true, payload };
}

/** Build the opaque `{payload}.{expiresAt}.{signature}` token. */
function sealToken(payload, ttlMs, secret) {
  const expiresAt = Date.now() + ttlMs;
  const signed = `${payload}.${expiresAt}`;
  return { token: Buffer.from(`${signed}.${computeSignature(signed, secret)}`).toString('base64url'), expiresAt };
}

/** Short-lived token granting read access to one stored assignment file. */
export function signAssignmentFileToken(storagePath, ttlMs = ASSIGNMENT_FILE_TTL_MS, secret = ASSIGNMENT_URL_SECRET) {
  return sealToken(String(storagePath), ttlMs, secret).token;
}

/**
 * Decode + validate a download token. Throws HttpError(401, INVALID_TOKEN) on ANY
 * failure without revealing which check failed. Returns { storagePath }.
 */
export function verifyAssignmentFileToken(token, secret = ASSIGNMENT_URL_SECRET) {
  let opened;
  try {
    opened = openToken(token, secret);
  } catch {
    opened = { ok: false };
  }
  if (!opened.ok) throw new HttpError(401, 'Invalid or expired token', 'INVALID_TOKEN');
  return { storagePath: opened.payload };
}

/**
 * The `fileId` returned to the seeker on upload. Lives exactly as long as the
 * staged file itself (STAGING_TTL_MS — see the comment on that constant; it is tied
 * to the client draft TTL). originalName is already sanitized and capped at 128
 * chars by the upload route, so the encoded payload stays bounded.
 */
export function signStagedFileToken(
  { uuid, ext, originalName, sizeBytes, mimeType },
  ttlMs = STAGING_TTL_MS,
  secret = ASSIGNMENT_URL_SECRET,
) {
  const payload = Buffer.from(JSON.stringify({
    uuid, ext, originalName, sizeBytes, mimeType,
  })).toString('base64url');
  return sealToken(payload, ttlMs, secret);
}

/**
 * Resolve a fileId back into its staged-file descriptor.
 *
 * Expiry gets its own code on purpose: 4b restores a saved draft that may reference
 * several fileIds, and has to tell the seeker exactly WHICH ones aged out so they
 * can re-upload just those. A single generic error would force them to redo all of
 * it. A tampered or malformed id is a different situation and stays opaque.
 */
export function verifyStagedFileToken(fileId, secret = ASSIGNMENT_URL_SECRET) {
  let opened;
  try {
    opened = openToken(fileId, secret);
  } catch {
    opened = { ok: false };
  }
  if (opened.expired) {
    throw new HttpError(400, 'This file has expired. Please re-upload it.', 'STAGED_FILE_EXPIRED');
  }
  if (!opened.ok) throw new HttpError(400, 'Invalid file reference', 'INVALID_FILE_ID');
  try {
    const { uuid, ext, originalName, sizeBytes, mimeType } = JSON.parse(
      Buffer.from(opened.payload, 'base64url').toString('utf8'),
    );
    return { uuid, ext, originalName, sizeBytes, mimeType };
  } catch {
    throw new HttpError(400, 'Invalid file reference', 'INVALID_FILE_ID');
  }
}

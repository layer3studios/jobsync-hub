// FILE: src/services/public/assignment-storage-service.js
// Local-disk storage for take-home assignment files, in two stages:
//
//   data/assignment-staging/      an upload that has not been submitted yet
//   data/assignment-submissions/  files committed by a successful apply
//
// A seeker uploads first and applies later, so bytes must survive between the two
// requests without an application row to hang off. Staging holds them; a successful
// apply PROMOTES them with a rename (atomic on one volume, so a file is never half
// in both places); a sweep reclaims whatever was never submitted.
//
// INVARIANT — ZIP FILES ARE NEVER EXTRACTED. This service stores and forwards
// opaque bytes; nothing here or downstream opens an archive. A zip bomb is only
// inert while that stays true, so if a future antivirus scan, preview thumbnail, or
// "browse the submission" feature wants to unpack one, it needs its own bounded,
// sandboxed extractor and a fresh threat review — do not add unzip here.
//
// On-disk names are ALWAYS `${uuid}.${ext}`. The candidate's filename is display
// metadata only and never touches the filesystem.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const STAGING_DIR = path.resolve(BACKEND_ROOT, 'data', 'assignment-staging');
const SUBMISSIONS_DIR = path.resolve(BACKEND_ROOT, 'data', 'assignment-submissions');

const STAGING_REL = path.posix.join('data', 'assignment-staging');
const SUBMISSIONS_REL = path.posix.join('data', 'assignment-submissions');

// Staged uploads live 7 days. This MUST equal the client-side draft TTL: a seeker
// who saves a draft, closes the tab, and comes back on day 6 has to find their
// files still here, or the restored draft references fileIds that no longer resolve.
// If you change one number, change the other. (Mirrored in the staged-token TTL.)
export const STAGING_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Create both assignment directories if missing. Called on boot. */
export function ensureAssignmentDirectories() {
  fs.mkdirSync(STAGING_DIR, { recursive: true });
  fs.mkdirSync(SUBMISSIONS_DIR, { recursive: true });
}

/** Absolute path of the staging directory — multer's diskStorage destination. */
export function stagingDirectoryPath() {
  return STAGING_DIR;
}

/** True only when a resolved absolute path stays inside one of the two dirs. */
export function isInsideAssignmentDirs(absolutePath) {
  const resolved = path.resolve(absolutePath || '');
  for (const dir of [STAGING_DIR, SUBMISSIONS_DIR]) {
    if (resolved === dir || resolved.startsWith(dir + path.sep)) return true;
  }
  return false;
}

/** The relative staging path for a (uuid, ext) pair. Never includes a user filename. */
export function stagedPathFor(uuid, ext) {
  return path.posix.join(STAGING_REL, `${uuid}.${ext}`);
}

/** Absolute path for a stored relative path, or null when it escapes the dirs. */
function safeAbsolute(relativePath) {
  if (!relativePath) return null;
  const absolutePath = path.resolve(BACKEND_ROOT, relativePath);
  return isInsideAssignmentDirs(absolutePath) ? absolutePath : null;
}

/**
 * Write a staged upload under a random filename. Returns the id, the relative path,
 * and the byte count. Used when the bytes are already in hand; the upload route
 * itself streams straight to disk via multer diskStorage and only calls
 * stagedPathFor, so a 10MB file is never held in memory.
 */
export function writeStagedFile(buffer, ext) {
  ensureAssignmentDirectories();
  const fileId = crypto.randomUUID();
  const relativePath = stagedPathFor(fileId, ext);
  fs.writeFileSync(path.resolve(BACKEND_ROOT, relativePath), buffer);
  return { fileId, storagePath: relativePath, sizeBytes: buffer.length };
}

/**
 * Move a staged file into the submissions directory. rename() is atomic within a
 * volume, so the file is never visible in both places or missing from both.
 * Returns the new relative path, or null when the source is already gone — a
 * caller retrying an apply must not be handed a path to a file that does not exist.
 */
export function promoteStagedFile(relativeStagingPath) {
  const source = safeAbsolute(relativeStagingPath);
  if (!source || !source.startsWith(STAGING_DIR + path.sep)) return null;
  if (!fs.existsSync(source)) return null;
  ensureAssignmentDirectories();
  const filename = path.basename(source);
  const target = path.join(SUBMISSIONS_DIR, filename);
  try {
    fs.renameSync(source, target);
  } catch {
    return null;
  }
  return path.posix.join(SUBMISSIONS_REL, filename);
}

/** Best-effort delete of one staged file. Missing files are not an error. */
export function deleteStagedFile(relativePath) {
  const absolutePath = safeAbsolute(relativePath);
  if (!absolutePath) return;
  try {
    fs.unlinkSync(absolutePath);
  } catch { /* already gone — nothing to clean up */ }
}

/** Best-effort delete of one committed submission file (data-deletion path). */
export function deleteSubmissionFile(relativePath) {
  const absolutePath = safeAbsolute(relativePath);
  if (!absolutePath) return;
  try {
    fs.unlinkSync(absolutePath);
  } catch { /* already gone — nothing to clean up */ }
}

/**
 * Delete staged files older than maxAgeMs. Returns the count removed. Only ever
 * touches the staging directory — committed submissions are never swept, they are
 * deleted explicitly through the data-deletion path.
 *
 * AGE ALONE IS NOT A SAFE ORPHAN TEST. A submission commits its row before the
 * bytes are renamed out of staging, so an old staged file may be the only copy of a
 * committed candidate's work — exactly the file we must never delete. `referenced`
 * carries every staging path a live submission still points at, and those are
 * skipped regardless of age.
 *
 * Passing `referenced: null` means "the caller could not determine what is
 * referenced", and the sweep does nothing rather than guess. Deleting a real
 * submission is unrecoverable; leaving stale bytes for one more day is not.
 */
export function sweepOldStagedFiles({ referenced = new Set(), maxAgeMs = STAGING_TTL_MS, now = Date.now() } = {}) {
  if (referenced === null) {
    console.warn('[assignments] sweep skipped — referenced staging paths are unknown');
    return 0;
  }
  ensureAssignmentDirectories();
  let removed = 0;
  for (const filename of fs.readdirSync(STAGING_DIR)) {
    const relativePath = path.posix.join(STAGING_REL, filename);
    if (referenced.has(relativePath)) continue; // committed work — never sweep, at any age
    const absolutePath = path.join(STAGING_DIR, filename);
    try {
      if (now - fs.statSync(absolutePath).mtimeMs > maxAgeMs) {
        fs.unlinkSync(absolutePath);
        removed += 1;
      }
    } catch { /* raced with another delete — skip */ }
  }
  return removed;
}

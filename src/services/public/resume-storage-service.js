// FILE: src/services/public/resume-storage-service.js
// Local-disk resume storage for MVP (C8/R2). Files are written to
// {backendRoot}/data/resumes/{uuid}.pdf with a random filename; the DB stores the
// relative path only. Files are NEVER served statically — Step 7 adds a signed
// download endpoint. The bytes never leave disk here.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const RESUME_DIR = path.join(BACKEND_ROOT, 'data', 'resumes');

/** Create data/resumes/ if missing. Called on boot. */
export function ensureResumeDirectory() {
  fs.mkdirSync(RESUME_DIR, { recursive: true });
}

/** Write a resume buffer to disk under a random filename. Returns its metadata. */
export function storeResumeFile(buffer) {
  ensureResumeDirectory();
  const filename = `${crypto.randomUUID()}.pdf`;
  const absolutePath = path.join(RESUME_DIR, filename);
  fs.writeFileSync(absolutePath, buffer);
  return { storagePath: path.posix.join('data', 'resumes', filename), sizeBytes: buffer.length };
}

/** Resolve a stored relative path and read the bytes (for Step 7's download). */
export function getResumeBuffer(storagePath) {
  const absolutePath = path.join(BACKEND_ROOT, storagePath);
  return fs.readFileSync(absolutePath);
}

/** Best-effort delete used to clean up when application creation fails. */
export function deleteResumeFile(storagePath) {
  try {
    fs.unlinkSync(path.join(BACKEND_ROOT, storagePath));
  } catch { /* file may not exist — nothing to clean up */ }
}

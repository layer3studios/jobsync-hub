// FILE: src/services/seeker/resume-tmp-storage.js
// Short-lived temp storage for queued PDF uploads (C8). The buffer is written to
// {backendRoot}/data/tmp/{uuid}.pdf so the upload endpoint can return a jobId in
// <500ms while the worker parses asynchronously. Every file is deleted the moment
// its job finishes (success OR failure); a boot sweep removes anything older than 1h
// left behind by a crash. Bytes never leave disk and are never served statically.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const TMP_DIR = path.join(BACKEND_ROOT, 'data', 'tmp');

/** Create data/tmp/ if missing. Called on boot (D6). */
export function ensureTmpDirectory() {
  fs.mkdirSync(TMP_DIR, { recursive: true });
}

/** Write a PDF buffer under a random filename. Returns the relative path stored on the job. */
export function writeTmpPdf(buffer) {
  ensureTmpDirectory();
  const filename = `${crypto.randomUUID()}.pdf`;
  fs.writeFileSync(path.join(TMP_DIR, filename), buffer);
  return path.posix.join('data', 'tmp', filename);
}

/** Read the bytes for a stored temp path (worker use). */
export function readTmpFile(relativePath) {
  return fs.readFileSync(path.join(BACKEND_ROOT, relativePath));
}

/** Best-effort delete of one temp file. Missing files are ignored. */
export function deleteTmpFile(relativePath) {
  if (!relativePath) return;
  try {
    fs.unlinkSync(path.join(BACKEND_ROOT, relativePath));
  } catch { /* already gone — nothing to clean up */ }
}

/** Delete temp files older than maxAgeMs (default 1h). Returns the count removed. */
export function sweepOldTmpFiles(maxAgeMs = 60 * 60 * 1000, now = Date.now()) {
  ensureTmpDirectory();
  let removed = 0;
  for (const filename of fs.readdirSync(TMP_DIR)) {
    const absolutePath = path.join(TMP_DIR, filename);
    try {
      if (now - fs.statSync(absolutePath).mtimeMs > maxAgeMs) {
        fs.unlinkSync(absolutePath);
        removed += 1;
      }
    } catch { /* raced with another delete — skip */ }
  }
  return removed;
}

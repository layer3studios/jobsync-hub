// FILE: tests/services/assignment-storage-service.test.js
// Real filesystem tests against the actual data/assignment-* directories. Every
// file this suite creates is tracked and removed in after(), so it never leaves
// residue behind or deletes anything it did not write.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  STAGING_TTL_MS, ensureAssignmentDirectories, stagingDirectoryPath, stagedPathFor,
  writeStagedFile, promoteStagedFile, deleteStagedFile, deleteSubmissionFile,
  sweepOldStagedFiles, isInsideAssignmentDirs,
} from '../../src/services/public/assignment-storage-service.js';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const STAGING_DIR = path.resolve(BACKEND_ROOT, 'data', 'assignment-staging');
const SUBMISSIONS_DIR = path.resolve(BACKEND_ROOT, 'data', 'assignment-submissions');

/** Relative paths this suite created, cleaned up in after(). */
const created = [];
function track(relativePath) { created.push(relativePath); return relativePath; }

before(() => { ensureAssignmentDirectories(); });
after(() => {
  for (const relativePath of created) {
    for (const dir of [BACKEND_ROOT]) {
      try { fs.unlinkSync(path.resolve(dir, relativePath)); } catch { /* already gone */ }
    }
  }
});

test('STAGING_TTL_MS is exactly 7 days — it must match the client draft TTL', () => {
  assert.equal(STAGING_TTL_MS, 7 * 24 * 60 * 60 * 1000);
  assert.equal(STAGING_TTL_MS, 604_800_000);
});

test('ensureAssignmentDirectories creates both directories and is idempotent', () => {
  ensureAssignmentDirectories();
  ensureAssignmentDirectories();
  assert.ok(fs.statSync(STAGING_DIR).isDirectory());
  assert.ok(fs.statSync(SUBMISSIONS_DIR).isDirectory());
  assert.equal(stagingDirectoryPath(), STAGING_DIR);
});

test('writeStagedFile names the file by uuid, never by the original filename', () => {
  const { fileId, storagePath, sizeBytes } = writeStagedFile(Buffer.from('hello take-home'), 'pdf');
  track(storagePath);

  assert.equal(sizeBytes, Buffer.from('hello take-home').length);
  assert.match(fileId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(path.basename(storagePath), `${fileId}.pdf`);
  assert.equal(storagePath.includes('take-home'), false);
  assert.equal(storagePath, stagedPathFor(fileId, 'pdf'));
  assert.ok(fs.existsSync(path.resolve(BACKEND_ROOT, storagePath)));
});

test('promoteStagedFile moves the file and the source no longer exists', () => {
  const { storagePath } = writeStagedFile(Buffer.from('answer bytes'), 'zip');
  const sourceAbsolute = path.resolve(BACKEND_ROOT, storagePath);

  const promoted = track(promoteStagedFile(storagePath));
  assert.ok(promoted.startsWith('data/assignment-submissions/'));
  assert.equal(fs.existsSync(sourceAbsolute), false, 'staged source must be gone');

  const target = path.resolve(BACKEND_ROOT, promoted);
  assert.ok(fs.existsSync(target));
  assert.equal(fs.readFileSync(target, 'utf8'), 'answer bytes');
  assert.equal(path.basename(promoted), path.basename(storagePath), 'uuid name is preserved');
});

test('promoteStagedFile on a missing source returns null and does not throw', () => {
  assert.equal(promoteStagedFile('data/assignment-staging/does-not-exist.pdf'), null);
  assert.equal(promoteStagedFile(''), null);
  assert.equal(promoteStagedFile(null), null);
  // A path outside the staging dir is refused rather than moved.
  assert.equal(promoteStagedFile('data/resumes/something.pdf'), null);
  assert.equal(promoteStagedFile('../../../etc/passwd'), null);
});

test('sweepOldStagedFiles removes files past the TTL and keeps newer ones', () => {
  const old = writeStagedFile(Buffer.from('stale'), 'pdf');
  const fresh = writeStagedFile(Buffer.from('recent'), 'pdf');
  track(old.storagePath); track(fresh.storagePath);

  const oldAbsolute = path.resolve(BACKEND_ROOT, old.storagePath);
  const freshAbsolute = path.resolve(BACKEND_ROOT, fresh.storagePath);

  const now = Date.now();
  const eightDaysAgo = new Date(now - 8 * 24 * 60 * 60 * 1000);
  const oneDayAgo = new Date(now - 24 * 60 * 60 * 1000);
  fs.utimesSync(oldAbsolute, eightDaysAgo, eightDaysAgo);
  fs.utimesSync(freshAbsolute, oneDayAgo, oneDayAgo);

  const removed = sweepOldStagedFiles(STAGING_TTL_MS, now);
  assert.ok(removed >= 1, 'the 8-day-old file must be swept');
  assert.equal(fs.existsSync(oldAbsolute), false);
  assert.equal(fs.existsSync(freshAbsolute), true, 'a 1-day-old file is still within the 7-day TTL');
});

test('sweepOldStagedFiles never touches the submissions directory', () => {
  const staged = writeStagedFile(Buffer.from('committed'), 'pdf');
  const promoted = track(promoteStagedFile(staged.storagePath));
  const target = path.resolve(BACKEND_ROOT, promoted);
  const longAgo = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
  fs.utimesSync(target, longAgo, longAgo);

  sweepOldStagedFiles(STAGING_TTL_MS, Date.now());
  assert.ok(fs.existsSync(target), 'committed submissions are never swept');
});

test('deleteStagedFile and deleteSubmissionFile are best-effort', () => {
  const { storagePath } = writeStagedFile(Buffer.from('to delete'), 'md');
  deleteStagedFile(storagePath);
  assert.equal(fs.existsSync(path.resolve(BACKEND_ROOT, storagePath)), false);
  // Deleting again, or deleting nothing, is not an error.
  deleteStagedFile(storagePath);
  deleteStagedFile('');
  deleteStagedFile(null);
  deleteSubmissionFile('data/assignment-submissions/missing.pdf');
});

test('delete helpers refuse paths outside the assignment directories', () => {
  const canary = path.resolve(BACKEND_ROOT, 'data', 'assignment-canary.txt');
  fs.writeFileSync(canary, 'do not delete me');
  try {
    deleteStagedFile('data/assignment-canary.txt');
    deleteSubmissionFile('../data/assignment-canary.txt');
    deleteStagedFile('data/assignment-staging/../assignment-canary.txt');
    assert.ok(fs.existsSync(canary), 'a path outside the two dirs must never be unlinked');
  } finally {
    fs.unlinkSync(canary);
  }
});

test('isInsideAssignmentDirs rejects traversal and absolute escapes', () => {
  assert.equal(isInsideAssignmentDirs(path.join(STAGING_DIR, 'a.pdf')), true);
  assert.equal(isInsideAssignmentDirs(path.join(SUBMISSIONS_DIR, 'a.pdf')), true);
  assert.equal(isInsideAssignmentDirs(STAGING_DIR), true);

  assert.equal(isInsideAssignmentDirs(path.resolve(BACKEND_ROOT, '../../etc/passwd')), false);
  assert.equal(isInsideAssignmentDirs(path.join(STAGING_DIR, '..', '..', 'etc', 'passwd')), false);
  assert.equal(isInsideAssignmentDirs(path.resolve(BACKEND_ROOT, 'data', 'resumes', 'x.pdf')), false);
  assert.equal(isInsideAssignmentDirs('/etc/passwd'), false);
  assert.equal(isInsideAssignmentDirs(''), false);
  assert.equal(isInsideAssignmentDirs(null), false);
  // A sibling directory sharing a name prefix must not pass the startsWith check.
  assert.equal(isInsideAssignmentDirs(`${STAGING_DIR}-evil/x.pdf`), false);
});

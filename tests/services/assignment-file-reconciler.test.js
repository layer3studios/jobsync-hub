// FILE: tests/services/assignment-file-reconciler.test.js
import './../_helpers/test-db.js';
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ObjectId } from 'mongodb';

import { dropCollections, closeTestDb } from '../_helpers/test-db.js';
import {
  ensureAssignmentSubmissionIndexes, insertAssignmentSubmission,
} from '../../src/models/public/assignment-submission-model.js';
import {
  ensureAssignmentDirectories, writeStagedFile, promoteStagedFile,
  sweepOldStagedFiles, STAGING_TTL_MS,
} from '../../src/services/public/assignment-storage-service.js';
import {
  reconcileAssignmentFiles, collectReferencedStagingPaths,
} from '../../src/services/public/assignment-file-reconciler.js';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const abs = (relativePath) => path.resolve(BACKEND_ROOT, relativePath);
const finalPathFor = (staging) => `data/assignment-submissions/${path.basename(staging)}`;

const created = [];
function track(...relativePaths) { created.push(...relativePaths); }

before(async () => { await reset(); });
beforeEach(async () => { await reset(); });
after(async () => {
  for (const relativePath of created) { try { fs.unlinkSync(abs(relativePath)); } catch { /* gone */ } }
  await closeTestDb();
});
async function reset() {
  await dropCollections('assignment_submissions');
  await ensureAssignmentSubmissionIndexes();
  ensureAssignmentDirectories();
}

/** A committed submission whose single file sits at `storagePath`. */
async function seedSubmission(storagePath, originalName = 'answer.pdf') {
  return insertAssignmentSubmission({
    applicationId: new ObjectId(), companyId: new ObjectId(), jobId: new ObjectId(),
    files: [{
      fileId: path.basename(storagePath).split('.')[0], originalName,
      storagePath, sizeBytes: 10, mimeType: 'application/pdf', uploadedAt: new Date(),
    }],
  });
}

test('a committed submission whose file is still in staging → promoted', async () => {
  const staged = writeStagedFile(Buffer.from('candidate work'), 'pdf');
  const finalPath = finalPathFor(staged.storagePath);
  track(staged.storagePath, finalPath);
  await seedSubmission(finalPath);

  assert.equal(fs.existsSync(abs(finalPath)), false, 'precondition: not yet promoted');

  const { promoted, missing } = await reconcileAssignmentFiles();
  assert.equal(promoted, 1);
  assert.equal(missing, 0);
  assert.equal(fs.existsSync(abs(finalPath)), true);
  assert.equal(fs.existsSync(abs(staged.storagePath)), false);
  assert.equal(fs.readFileSync(abs(finalPath), 'utf8'), 'candidate work');
});

test('a file already in its final location → no-op', async () => {
  const staged = writeStagedFile(Buffer.from('already moved'), 'pdf');
  const finalPath = promoteStagedFile(staged.storagePath);
  track(finalPath);
  await seedSubmission(finalPath);

  const { promoted, missing } = await reconcileAssignmentFiles();
  assert.equal(promoted, 0);
  assert.equal(missing, 0);
  assert.equal(fs.existsSync(abs(finalPath)), true);
});

test('a file missing from BOTH locations → counted missing, row untouched, no throw', async () => {
  const finalPath = 'data/assignment-submissions/deadbeef-0000-0000-0000-000000000000.pdf';
  const submission = await seedSubmission(finalPath);

  const { promoted, missing } = await reconcileAssignmentFiles();
  assert.equal(promoted, 0);
  assert.equal(missing, 1);

  // The row survives — the fix is a conversation with the candidate, not a delete.
  const { col } = await import('../../src/Db/connection.js');
  const collection = await col('assignment_submissions');
  const stored = await collection.findOne({ _id: submission._id });
  assert.ok(stored);
  assert.equal(stored.files.length, 1);
});

test('a submission with filesDeletedAt set is ignored by the reconciler', async () => {
  const finalPath = 'data/assignment-submissions/aaaaaaaa-0000-0000-0000-000000000000.pdf';
  const submission = await seedSubmission(finalPath);
  const { col } = await import('../../src/Db/connection.js');
  const collection = await col('assignment_submissions');
  await collection.updateOne({ _id: submission._id }, { $set: { filesDeletedAt: new Date() } });

  const { promoted, missing } = await reconcileAssignmentFiles();
  assert.equal(promoted, 0);
  assert.equal(missing, 0, 'a tombstoned submission is not expected to have files');
});

test('SWEEP: a 30-day-old staged file referenced by a committed submission is NOT deleted', async () => {
  const staged = writeStagedFile(Buffer.from('committed work'), 'pdf');
  const finalPath = finalPathFor(staged.storagePath);
  track(staged.storagePath, finalPath);
  await seedSubmission(finalPath);

  // Age it far past the 7-day TTL.
  const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  fs.utimesSync(abs(staged.storagePath), longAgo, longAgo);

  const referenced = await collectReferencedStagingPaths();
  assert.equal(referenced.has(staged.storagePath), true, 'the staging path must be recognised as referenced');

  const removed = sweepOldStagedFiles({ referenced, maxAgeMs: STAGING_TTL_MS, now: Date.now() });
  assert.equal(fs.existsSync(abs(staged.storagePath)), true,
    'age alone must never delete a file a committed submission depends on');
  assert.equal(removed, 0);
});

test('SWEEP: an UNREFERENCED staged file past the TTL IS deleted', async () => {
  const orphan = writeStagedFile(Buffer.from('never submitted'), 'pdf');
  track(orphan.storagePath);
  const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  fs.utimesSync(abs(orphan.storagePath), longAgo, longAgo);

  const referenced = await collectReferencedStagingPaths();
  assert.equal(referenced.has(orphan.storagePath), false);

  const removed = sweepOldStagedFiles({ referenced, maxAgeMs: STAGING_TTL_MS, now: Date.now() });
  assert.ok(removed >= 1);
  assert.equal(fs.existsSync(abs(orphan.storagePath)), false);
});

test('SWEEP: referenced=null means "unknown" and disables the sweep entirely', async () => {
  const orphan = writeStagedFile(Buffer.from('would be swept'), 'pdf');
  track(orphan.storagePath);
  const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  fs.utimesSync(abs(orphan.storagePath), longAgo, longAgo);

  const removed = sweepOldStagedFiles({ referenced: null, maxAgeMs: STAGING_TTL_MS, now: Date.now() });
  assert.equal(removed, 0);
  assert.equal(fs.existsSync(abs(orphan.storagePath)), true,
    'an unknown referenced-set must never be treated as "nothing is referenced"');
});

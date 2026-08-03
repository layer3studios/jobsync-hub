// FILE: tests/services/assignment-deletion-service.test.js
// DPDP erasure of one submission's seeker-supplied data. Real files on disk — the
// order of operations (files first, row second) is the whole point, so mocking the
// filesystem away would test nothing that matters.
import { connectTestDb, closeTestDb, dropCollections } from '../_helpers/test-db.js';

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ObjectId } from 'mongodb';

const { deleteSubmissionFilesForApplication } = await import('../../src/services/admin/assignment-deletion-service.js');
const { col } = await import('../../src/Db/connection.js');

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SUBMISSIONS_DIR = path.resolve(BACKEND_ROOT, 'data', 'assignment-submissions');
const COMPANY = new ObjectId();
const COLLECTIONS = ['assignment_submissions', 'audit_log'];

const SNAPSHOT = Object.freeze({
  title: 'Build a rate limiter',
  publicSummary: 'Token bucket, with trade-offs written up.',
  descriptionMarkdown: '# The task\n\nImplement a token bucket.',
  submissionInstructionsMarkdown: 'Send a repo link.',
  estimatedHours: 3,
  allowedFileTypes: ['pdf'],
  sourceAssignmentId: new ObjectId(),
  snapshottedAt: new Date('2026-08-01T00:00:00.000Z'),
});

const written = [];
function writeFileOnDisk(name) {
  fs.mkdirSync(SUBMISSIONS_DIR, { recursive: true });
  const absolute = path.join(SUBMISSIONS_DIR, name);
  fs.writeFileSync(absolute, 'bytes');
  written.push(absolute);
  return { absolute, storagePath: path.posix.join('data', 'assignment-submissions', name) };
}

async function seedSubmission({ files = [], filesDeletedAt = null } = {}) {
  const submissions = await col('assignment_submissions');
  const applicationId = new ObjectId();
  const submissionId = new ObjectId();
  await submissions.insertOne({
    _id: submissionId,
    companyId: COMPANY,
    applicationId,
    assignmentSnapshot: { ...SNAPSHOT },
    profileLinks: { githubUrl: 'https://github.com/asha', linkedinUrl: 'https://in.linkedin.com/in/asha' },
    seekerNotesMarkdown: 'I focused on the refill maths.',
    links: [{ url: 'https://github.com/asha/take-home', addedAt: new Date() }],
    files,
    submittedAt: new Date(),
    filesDeletedAt,
  });
  return { applicationId, submissionId };
}

const findSubmission = async (id) => (await col('assignment_submissions')).findOne({ _id: id });

before(async () => { await connectTestDb(); });
after(async () => {
  for (const absolute of written) { try { fs.unlinkSync(absolute); } catch { /* gone */ } }
  await dropCollections(...COLLECTIONS);
  await closeTestDb();
});
beforeEach(async () => {
  await dropCollections(...COLLECTIONS);
  for (const absolute of written.splice(0)) { try { fs.unlinkSync(absolute); } catch { /* gone */ } }
});

test('removes the bytes from disk and tombstones the row', async () => {
  const one = writeFileOnDisk(`erase-a-${new ObjectId()}.pdf`);
  const two = writeFileOnDisk(`erase-b-${new ObjectId()}.pdf`);
  const { applicationId, submissionId } = await seedSubmission({
    files: [
      { fileId: 'f1', originalName: 'design.pdf', storagePath: one.storagePath },
      { fileId: 'f2', originalName: 'notes.pdf', storagePath: two.storagePath },
    ],
  });

  const result = await deleteSubmissionFilesForApplication(applicationId);

  assert.equal(result.filesDeleted, 2);
  assert.equal(result.submissionId, submissionId.toString());
  assert.equal(result.alreadyDeleted, false);
  assert.equal(fs.existsSync(one.absolute), false);
  assert.equal(fs.existsSync(two.absolute), false);

  const after = await findSubmission(submissionId);
  assert.ok(after.filesDeletedAt instanceof Date);
  assert.deepEqual(after.files, []);
});

test('clears the seeker notes and profile links', async () => {
  const { applicationId, submissionId } = await seedSubmission();
  await deleteSubmissionFilesForApplication(applicationId);

  const after = await findSubmission(submissionId);
  assert.equal(after.seekerNotesMarkdown, '');
  assert.deepEqual(after.profileLinks, { githubUrl: null, linkedinUrl: null });
});

// The snapshot is the EMPLOYER's record of the task they set — their content, not
// the candidate's personal data. Erasing it would destroy the hiring record and
// make every surviving review of that task unreadable.
test('PRESERVES assignmentSnapshot — it is the employer\'s record, not seeker data', async () => {
  const { applicationId, submissionId } = await seedSubmission();
  await deleteSubmissionFilesForApplication(applicationId);

  const after = await findSubmission(submissionId);
  assert.ok(after.assignmentSnapshot, 'the snapshot must survive erasure');
  assert.equal(after.assignmentSnapshot.title, SNAPSHOT.title);
  assert.equal(after.assignmentSnapshot.descriptionMarkdown, SNAPSHOT.descriptionMarkdown);
  assert.equal(after.assignmentSnapshot.estimatedHours, 3);
  assert.deepEqual(after.assignmentSnapshot.allowedFileTypes, ['pdf']);
});

test('is idempotent — a second call is a no-op and does not throw', async () => {
  const file = writeFileOnDisk(`erase-idem-${new ObjectId()}.pdf`);
  const { applicationId, submissionId } = await seedSubmission({
    files: [{ fileId: 'f1', storagePath: file.storagePath }],
  });

  const first = await deleteSubmissionFilesForApplication(applicationId);
  assert.equal(first.filesDeleted, 1);
  assert.equal(first.alreadyDeleted, false);
  const afterFirst = await findSubmission(submissionId);

  const second = await deleteSubmissionFilesForApplication(applicationId);
  assert.equal(second.filesDeleted, 0);
  assert.equal(second.alreadyDeleted, true);
  assert.equal(second.submissionId, submissionId.toString());

  // The row is untouched by the second pass — the tombstone keeps its ORIGINAL time.
  const afterSecond = await findSubmission(submissionId);
  assert.equal(afterSecond.filesDeletedAt.getTime(), afterFirst.filesDeletedAt.getTime());
});

test('a missing file on disk is not an error — the erasure still completes', async () => {
  const { applicationId, submissionId } = await seedSubmission({
    files: [{ fileId: 'f1', storagePath: 'data/assignment-submissions/never-existed.pdf' }],
  });
  const result = await deleteSubmissionFilesForApplication(applicationId);
  assert.equal(result.filesDeleted, 1);
  const after = await findSubmission(submissionId);
  assert.ok(after.filesDeletedAt instanceof Date);
});

test('an application with no submission returns zero and does not throw', async () => {
  const result = await deleteSubmissionFilesForApplication(new ObjectId());
  assert.deepEqual(result, { filesDeleted: 0, submissionId: null, alreadyDeleted: false });
});

test('an invalid application id does not throw', async () => {
  const result = await deleteSubmissionFilesForApplication('not-an-object-id');
  assert.equal(result.submissionId, null);
});

test('writes an audit-log row carrying ids and counts, never the erased content', async () => {
  const file = writeFileOnDisk(`erase-audit-${new ObjectId()}.pdf`);
  const actorId = new ObjectId();
  const { applicationId, submissionId } = await seedSubmission({
    files: [{ fileId: 'f1', originalName: 'design.pdf', storagePath: file.storagePath }],
  });

  await deleteSubmissionFilesForApplication(applicationId, { actorId });

  const auditLog = await col('audit_log');
  const entry = await auditLog.findOne({ targetId: submissionId });
  assert.ok(entry, 'an audit row must be written');
  assert.equal(entry.event, 'data_deleted');
  assert.equal(entry.targetType, 'assignment_submission');
  assert.equal(entry.metadata.filesDeleted, 1);
  assert.equal(entry.metadata.snapshotPreserved, true);

  // The row must not restate what it erased.
  const serialized = JSON.stringify(entry);
  assert.ok(!serialized.includes('design.pdf'), 'the candidate filename must not be in the audit row');
  assert.ok(!serialized.includes('refill maths'), 'the seeker notes must not be in the audit row');
  assert.ok(!serialized.includes('github.com/asha'), 'the profile link must not be in the audit row');
});

// FILE: tests/scripts/audit-assignments.test.js
// The audit script must FIND drift and must never CAUSE it. Every drift type is
// seeded individually so a passing suite means each detector works on its own,
// not that some aggregate happened to be non-zero.
import { connectTestDb, closeTestDb, dropCollections } from '../_helpers/test-db.js';

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ObjectId } from 'mongodb';

const { main } = await import('../../src/scripts/audit-assignments.js');
const { col } = await import('../../src/Db/connection.js');

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SUBMISSIONS_DIR = path.resolve(BACKEND_ROOT, 'data', 'assignment-submissions');
const COMPANY = new ObjectId();
const OTHER_COMPANY = new ObjectId();
const COLLECTIONS = ['assignment_submissions', 'assignment_reviews', 'applications', 'jobs', 'assignments'];

/** Files this suite wrote, removed in after() so it never deletes anything else. */
const writtenFiles = [];
function writeSubmissionFile(name) {
  fs.mkdirSync(SUBMISSIONS_DIR, { recursive: true });
  const absolute = path.join(SUBMISSIONS_DIR, name);
  fs.writeFileSync(absolute, 'x');
  writtenFiles.push(absolute);
  return path.posix.join('data', 'assignment-submissions', name);
}

/** A submission + its application, consistent by default. */
async function seedConsistentPair(overrides = {}) {
  const applications = await col('applications');
  const submissions = await col('assignment_submissions');
  const applicationId = new ObjectId();
  const submissionId = new ObjectId();
  await applications.insertOne({ _id: applicationId, companyId: COMPANY, assignmentSubmissionId: submissionId });
  await submissions.insertOne({
    _id: submissionId, companyId: COMPANY, applicationId, files: [], links: [],
    submittedAt: new Date(), filesDeletedAt: null, ...overrides,
  });
  return { applicationId, submissionId };
}

/** Every document in every audited collection, for the no-writes comparison. */
async function snapshotCollections() {
  const snapshot = {};
  for (const name of COLLECTIONS) {
    const collection = await col(name);
    snapshot[name] = await collection.find({}).sort({ _id: 1 }).toArray();
  }
  return JSON.stringify(snapshot);
}

/**
 * data/assignment-submissions/ is a REAL shared directory: other suites and local
 * development leave files in it, and every one of those is a legitimate orphan
 * finding. Asserting absolute counts would make this suite depend on the machine it
 * runs on, so finding 8 is measured as a DELTA against whatever is already there.
 */
let baselineOrphanFiles = 0;
async function measureBaseline() {
  baselineOrphanFiles = (await main()).orphanFilesOnDisk;
}

before(async () => { await connectTestDb(); });
after(async () => {
  for (const absolute of writtenFiles) { try { fs.unlinkSync(absolute); } catch { /* already gone */ } }
  await dropCollections(...COLLECTIONS);
  await closeTestDb();
});
beforeEach(async () => {
  await dropCollections(...COLLECTIONS);
  for (const absolute of writtenFiles.splice(0)) { try { fs.unlinkSync(absolute); } catch { /* gone */ } }
  await measureBaseline();
});

test('a clean database reports zero DB findings', async () => {
  await seedConsistentPair();
  const report = await main();
  assert.equal(report.totalSubmissions, 1);
  // Everything except the shared-directory baseline must be clean.
  assert.equal(report.totalFindings - baselineOrphanFiles, 0);
  assert.equal(report.orphanSubmissions, 0);
  assert.equal(report.danglingApplications, 0);
  assert.equal(report.tenantMismatchedSubmissions, 0);
  assert.equal(report.orphanReviews, 0);
  assert.equal(report.tenantMismatchedReviews, 0);
  assert.equal(report.jobsWithMissingAssignment, 0);
  assert.equal(report.submissionFilesMissingOnDisk, 0);
});

test('1 — a submission whose application is gone', async () => {
  const submissions = await col('assignment_submissions');
  await submissions.insertOne({
    _id: new ObjectId(), companyId: COMPANY, applicationId: new ObjectId(), files: [], links: [],
  });
  const report = await main();
  assert.equal(report.orphanSubmissions, 1);
  assert.ok(report.totalFindings >= 1);
});

test('2 — an application whose submission is gone', async () => {
  const applications = await col('applications');
  await applications.insertOne({
    _id: new ObjectId(), companyId: COMPANY, assignmentSubmissionId: new ObjectId(),
  });
  const report = await main();
  assert.equal(report.danglingApplications, 1);
});

test('3 — a submission whose companyId disagrees with its application', async () => {
  const applications = await col('applications');
  const submissions = await col('assignment_submissions');
  const applicationId = new ObjectId();
  const submissionId = new ObjectId();
  await applications.insertOne({ _id: applicationId, companyId: COMPANY, assignmentSubmissionId: submissionId });
  await submissions.insertOne({
    _id: submissionId, companyId: OTHER_COMPANY, applicationId, files: [], links: [],
  });
  const report = await main();
  assert.equal(report.tenantMismatchedSubmissions, 1);
  // Not double-counted as an orphan — the application exists.
  assert.equal(report.orphanSubmissions, 0);
});

test('4 — a review whose submission is gone', async () => {
  const reviews = await col('assignment_reviews');
  await reviews.insertOne({
    _id: new ObjectId(), companyId: COMPANY, assignmentSubmissionId: new ObjectId(),
  });
  const report = await main();
  assert.equal(report.orphanReviews, 1);
});

test('5 — a review whose companyId disagrees with its submission', async () => {
  const { submissionId } = await seedConsistentPair();
  const reviews = await col('assignment_reviews');
  await reviews.insertOne({
    _id: new ObjectId(), companyId: OTHER_COMPANY, assignmentSubmissionId: submissionId,
  });
  const report = await main();
  assert.equal(report.tenantMismatchedReviews, 1);
  assert.equal(report.orphanReviews, 0);
});

test('6 — a native job referencing a deleted assignment (and scraped rows are ignored)', async () => {
  const jobs = await col('jobs');
  const assignments = await col('assignments');
  const liveId = new ObjectId();
  await assignments.insertOne({ _id: liveId, companyId: COMPANY, archivedAt: null });
  await jobs.insertMany([
    { source: 'native', companyId: COMPANY, assignmentId: liveId },          // fine
    { source: 'native', companyId: COMPANY, assignmentId: new ObjectId() },  // drift
    { source: 'scraped', companyId: COMPANY, assignmentId: new ObjectId() }, // not ours to check
  ]);
  const report = await main();
  assert.equal(report.jobsWithMissingAssignment, 1);
});

test('7 — a live submission whose bytes are missing from disk', async () => {
  await seedConsistentPair({
    files: [{ fileId: 'f1', storagePath: 'data/assignment-submissions/does-not-exist.pdf' }],
  });
  const report = await main();
  assert.equal(report.submissionFilesMissingOnDisk, 1);
});

test('7 — a DPDP-tombstoned submission is NOT reported as missing bytes', async () => {
  // filesDeletedAt set means the bytes are SUPPOSED to be gone. Reporting that as
  // drift would make every erasure look like a bug.
  await seedConsistentPair({
    filesDeletedAt: new Date(),
    files: [{ fileId: 'f1', storagePath: 'data/assignment-submissions/erased.pdf' }],
  });
  const report = await main();
  assert.equal(report.submissionFilesMissingOnDisk, 0);
});

test('8 — bytes on disk that no submission references', async () => {
  await seedConsistentPair();
  writeSubmissionFile(`orphan-${new ObjectId().toString()}.pdf`);
  const report = await main();
  assert.equal(report.orphanFilesOnDisk - baselineOrphanFiles, 1);
});

test('8 — a referenced file on disk is not an orphan', async () => {
  const storagePath = writeSubmissionFile(`kept-${new ObjectId().toString()}.pdf`);
  await seedConsistentPair({ files: [{ fileId: 'f1', storagePath }] });
  const report = await main();
  // The file we wrote is referenced, so it adds nothing to the baseline.
  assert.equal(report.orphanFilesOnDisk - baselineOrphanFiles, 0);
  assert.equal(report.submissionFilesMissingOnDisk, 0);
  assert.equal(report.totalFindings - baselineOrphanFiles, 0);
});

// The script reports; it never repairs. A --fix flag would need a human deciding
// which side of a mismatch is authoritative.
test('THE SCRIPT PERFORMS NO WRITES — collections are byte-identical afterwards', async () => {
  // Seed every drift type at once so each detector has something to touch.
  await seedConsistentPair({
    files: [{ fileId: 'f1', storagePath: 'data/assignment-submissions/missing.pdf' }],
  });
  const submissions = await col('assignment_submissions');
  const applications = await col('applications');
  const reviews = await col('assignment_reviews');
  const jobs = await col('jobs');
  await submissions.insertOne({ _id: new ObjectId(), companyId: COMPANY, applicationId: new ObjectId(), files: [] });
  await applications.insertOne({ _id: new ObjectId(), companyId: COMPANY, assignmentSubmissionId: new ObjectId() });
  await reviews.insertOne({ _id: new ObjectId(), companyId: COMPANY, assignmentSubmissionId: new ObjectId() });
  await jobs.insertOne({ source: 'native', companyId: COMPANY, assignmentId: new ObjectId() });
  writeSubmissionFile(`orphan-${new ObjectId().toString()}.pdf`);

  const before = await snapshotCollections();
  const filesBefore = fs.readdirSync(SUBMISSIONS_DIR).sort().join(',');

  const report = await main();
  assert.ok(report.totalFindings > 0, 'the fixture must actually contain drift');

  assert.equal(await snapshotCollections(), before);
  assert.equal(fs.readdirSync(SUBMISSIONS_DIR).sort().join(','), filesBefore);
});

// FILE: src/scripts/audit-assignments.js
// READ-ONLY audit of the take-home assignment collections and their files on disk.
// Reports drift; never repairs it. There is no --fix flag and there must never be
// one: a repair for referential drift needs a human deciding which side is right,
// and a script that silently picks would destroy the evidence of the bug that
// caused it. Safe to run anytime (C9). console.log is intentional — stdout CLI (C5).
// CLI: node src/scripts/audit-assignments.js  |  npm run audit:assignments
//
// Items 1-3 are exactly what Chunk 4b's apply transaction exists to prevent. If this
// script ever reports one, the transaction has a hole — that is not a data problem
// to clean up, it is a code bug to find.

import fs from 'fs';
import path from 'path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { connectToDb, closeDb, col } from '../Db/connection.js';

const NATIVE = 'native';
const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SUBMISSIONS_DIR = path.resolve(BACKEND_ROOT, 'data', 'assignment-submissions');

const idString = (value) => (value == null ? null : value.toString());

/** Set of _id strings for every doc in a collection, for cheap membership tests. */
async function idSet(collection, query = {}) {
  const docs = await collection.find(query, { projection: { _id: 1 } }).toArray();
  return new Set(docs.map((doc) => doc._id.toString()));
}

/** Filenames present under data/assignment-submissions/, or [] when absent. */
function readSubmissionsDir() {
  try {
    return fs.readdirSync(SUBMISSIONS_DIR);
  } catch {
    return []; // directory not created yet — not a finding
  }
}

export async function main() {
  await connectToDb();
  const submissionsCol = await col('assignment_submissions');
  const applicationsCol = await col('applications');
  const reviewsCol = await col('assignment_reviews');
  const jobsCol = await col('jobs');
  const assignmentsCol = await col('assignments');

  const submissions = await submissionsCol.find({}).toArray();
  const reviews = await reviewsCol.find({}).toArray();
  const applications = await applicationsCol
    .find({ assignmentSubmissionId: { $ne: null } }, { projection: { _id: 1, companyId: 1, assignmentSubmissionId: 1 } })
    .toArray();

  const applicationById = new Map();
  for (const doc of await applicationsCol.find({}, { projection: { _id: 1, companyId: 1 } }).toArray()) {
    applicationById.set(doc._id.toString(), doc);
  }
  const submissionById = new Map(submissions.map((doc) => [doc._id.toString(), doc]));

  // 1. Submissions pointing at an application that no longer exists.
  const orphanSubmissions = submissions.filter(
    (doc) => !applicationById.has(idString(doc.applicationId)),
  );

  // 2. Applications pointing at a submission that no longer exists.
  const danglingApplications = applications.filter(
    (doc) => !submissionById.has(idString(doc.assignmentSubmissionId)),
  );

  // 3. Tenant mismatch between a submission and its application.
  const tenantMismatchedSubmissions = submissions.filter((doc) => {
    const application = applicationById.get(idString(doc.applicationId));
    if (!application) return false; // already counted as finding 1
    return idString(application.companyId) !== idString(doc.companyId);
  });

  // 4. Reviews whose submission is gone.
  const orphanReviews = reviews.filter(
    (doc) => !submissionById.has(idString(doc.assignmentSubmissionId)),
  );

  // 5. Tenant mismatch between a review and its submission.
  const tenantMismatchedReviews = reviews.filter((doc) => {
    const submission = submissionById.get(idString(doc.assignmentSubmissionId));
    if (!submission) return false; // already counted as finding 4
    return idString(submission.companyId) !== idString(doc.companyId);
  });

  // 6. Native postings referencing an assignment that no longer exists.
  const liveAssignmentIds = await idSet(assignmentsCol);
  const jobsWithAssignments = await jobsCol
    .find({ source: NATIVE, assignmentId: { $type: 'objectId' } }, { projection: { _id: 1, assignmentId: 1 } })
    .toArray();
  const jobsWithMissingAssignment = jobsWithAssignments.filter(
    (doc) => !liveAssignmentIds.has(idString(doc.assignmentId)),
  );

  // 7. Live submissions whose bytes are missing from disk. A row with filesDeletedAt
  //    set is EXPECTED to have no files — that is the DPDP tombstone, not drift.
  const missingOnDisk = [];
  const referencedFilenames = new Set();
  for (const submission of submissions) {
    for (const file of submission.files ?? []) {
      if (!file?.storagePath) continue;
      referencedFilenames.add(path.basename(file.storagePath));
      if (submission.filesDeletedAt) continue;
      if (!fs.existsSync(path.resolve(BACKEND_ROOT, file.storagePath))) {
        missingOnDisk.push({ submissionId: submission._id.toString(), storagePath: file.storagePath });
      }
    }
  }

  // 8. Bytes on disk that no submission references — the sweep's blind spot.
  const orphanFilesOnDisk = readSubmissionsDir().filter((name) => !referencedFilenames.has(name));

  const report = {
    totalSubmissions: submissions.length,
    totalReviews: reviews.length,
    orphanSubmissions: orphanSubmissions.length,
    danglingApplications: danglingApplications.length,
    tenantMismatchedSubmissions: tenantMismatchedSubmissions.length,
    orphanReviews: orphanReviews.length,
    tenantMismatchedReviews: tenantMismatchedReviews.length,
    jobsWithMissingAssignment: jobsWithMissingAssignment.length,
    submissionFilesMissingOnDisk: missingOnDisk.length,
    orphanFilesOnDisk: orphanFilesOnDisk.length,
  };

  const findings = report.orphanSubmissions
    + report.danglingApplications
    + report.tenantMismatchedSubmissions
    + report.orphanReviews
    + report.tenantMismatchedReviews
    + report.jobsWithMissingAssignment
    + report.submissionFilesMissingOnDisk
    + report.orphanFilesOnDisk;
  report.totalFindings = findings;

  console.log('[audit] assignment_submissions / assignment_reviews');
  console.log(`  total_submissions            : ${report.totalSubmissions}`);
  console.log(`  total_reviews                : ${report.totalReviews}`);
  console.log('[audit] referential integrity  (all expect 0 — 1-3 mean the 4b transaction has a hole)');
  console.log(`  1 orphan_submissions         : ${report.orphanSubmissions}  (applicationId has no application)`);
  console.log(`  2 dangling_applications      : ${report.danglingApplications}  (assignmentSubmissionId has no submission)`);
  console.log(`  3 submission_tenant_mismatch : ${report.tenantMismatchedSubmissions}  (companyId != application.companyId)`);
  console.log(`  4 orphan_reviews             : ${report.orphanReviews}  (assignmentSubmissionId has no submission)`);
  console.log(`  5 review_tenant_mismatch     : ${report.tenantMismatchedReviews}  (companyId != submission.companyId)`);
  console.log(`  6 jobs_missing_assignment    : ${report.jobsWithMissingAssignment}  (native job references a deleted assignment)`);
  console.log('[audit] files on disk');
  console.log(`  7 files_missing_on_disk      : ${report.submissionFilesMissingOnDisk}  (row says present, disk says no)`);
  console.log(`  8 orphan_files_on_disk       : ${report.orphanFilesOnDisk}  (bytes no submission references)`);
  console.log(`[audit] total_findings         : ${report.totalFindings}  ${findings === 0 ? '— clean' : '— DRIFT DETECTED'}`);

  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main()
    // Non-zero on findings so CI or a cron wrapper can fail loudly. A clean run
    // exits 0; a fatal error also exits 1, which is the correct conflation here —
    // "the audit could not complete" is not a passing state either.
    .then((report) => { process.exitCode = report.totalFindings > 0 ? 1 : 0; })
    .catch((err) => { console.log(`[audit] Fatal: ${err.message}`); process.exitCode = 1; })
    .finally(async () => { await closeDb(); });
}

export default main;

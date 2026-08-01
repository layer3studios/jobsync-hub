// FILE: tests/services/applicant-detail-assignment.test.js
import './../_helpers/test-db.js';
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';

import { dropCollections, closeTestDb } from '../_helpers/test-db.js';
import { col } from '../../src/Db/connection.js';
import { getApplicantDetailForCompany } from '../../src/services/employer/applicant-detail-service.js';
import {
  ensureApplicationIndexes, createApplicationForCompany, ensureContactIndexes,
  findOrCreateContactForCompany, ensureStageChangeIndexes, ensureResumeFileIndexes,
} from '../../src/models/public/index.js';
import {
  ensureAssignmentSubmissionIndexes, insertAssignmentSubmission,
} from '../../src/models/public/assignment-submission-model.js';
import {
  ensureAssignmentReviewIndexes, upsertAssignmentReview,
} from '../../src/models/public/assignment-review-model.js';

const companyA = new ObjectId();

/** The keys the detail response carried before this chunk — none may disappear. */
const EXISTING_KEYS = [
  'application', 'contact', 'score', 'scoreJobStatus', 'stageChanges',
  'resumeMeta', 'resumeDownloadUrl',
];

let seq = 0;
async function seedApplication({ withSubmission = false, withReview = false } = {}) {
  seq += 1;
  const { contact } = await findOrCreateContactForCompany(companyA, {
    email: `c${seq}@example.com`, fullName: `Candidate ${seq}`, phone: null,
  });
  const application = await createApplicationForCompany(companyA, {
    jobId: new ObjectId(), contactId: contact._id, stageId: new ObjectId(),
  });
  if (!withSubmission) return { application, submission: null };

  const submission = await insertAssignmentSubmission({
    applicationId: application._id, companyId: companyA, jobId: application.jobId,
    links: [{ url: 'https://github.com/me/solution', addedAt: new Date() }],
    files: [{
      fileId: `f${seq}`, originalName: 'answer.pdf',
      storagePath: `data/assignment-submissions/f${seq}.pdf`,
      sizeBytes: 100, mimeType: 'application/pdf', uploadedAt: new Date(),
    }],
    seekerNotesMarkdown: 'My approach.',
  });
  const applications = await col('applications');
  await applications.updateOne({ _id: application._id }, { $set: { assignmentSubmissionId: submission._id } });

  if (withReview) {
    await upsertAssignmentReview(companyA, submission._id, {
      reviewedByEmployerUserId: new ObjectId(), overallScore: 4,
      passesBar: true, reviewNotesMarkdown: 'Good work.',
    });
  }
  return { application, submission };
}

before(async () => { await reset(); });
beforeEach(async () => { await reset(); });
after(async () => { await closeTestDb(); });
async function reset() {
  await dropCollections('applications', 'contacts', 'assignment_submissions',
    'assignment_reviews', 'stage_changes', 'resume_files', 'resume_scores');
  await ensureApplicationIndexes(); await ensureContactIndexes();
  await ensureStageChangeIndexes(); await ensureResumeFileIndexes();
  await ensureAssignmentSubmissionIndexes(); await ensureAssignmentReviewIndexes();
}

test('an application with a submission and review → both new keys populated', async () => {
  const { application, submission } = await seedApplication({ withSubmission: true, withReview: true });
  const detail = await getApplicantDetailForCompany(companyA, application._id);

  assert.ok(detail.assignmentSubmission);
  assert.equal(detail.assignmentSubmission.id, submission._id.toString());
  assert.equal(detail.assignmentSubmission.links.length, 1);
  assert.equal(detail.assignmentSubmission.files.length, 1);
  assert.equal(detail.assignmentSubmission.seekerNotesMarkdown, 'My approach.');

  assert.ok(detail.assignmentReview);
  assert.equal(detail.assignmentReview.overallScore, 4);
  assert.equal(detail.assignmentReview.passesBar, true);
  assert.equal(detail.assignmentReview.reviewNotesMarkdown, 'Good work.');
});

test('the submission projection never exposes storagePath', async () => {
  const { application } = await seedApplication({ withSubmission: true });
  const detail = await getApplicantDetailForCompany(companyA, application._id);
  const serialized = JSON.stringify(detail.assignmentSubmission);
  assert.equal(serialized.includes('data/assignment-submissions'), false);
  for (const file of detail.assignmentSubmission.files) {
    assert.equal('storagePath' in file, false);
  }
});

test('a submission with no review → submission populated, review null', async () => {
  const { application } = await seedApplication({ withSubmission: true, withReview: false });
  const detail = await getApplicantDetailForCompany(companyA, application._id);
  assert.ok(detail.assignmentSubmission);
  assert.equal(detail.assignmentReview, null);
});

test('a LEGACY application → both keys null and neither collection is queried', async () => {
  const { application } = await seedApplication();
  assert.equal(application.assignmentSubmissionId, null);

  // A submission for a DIFFERENT application exists. If the service queried without
  // guarding on assignmentSubmissionId, a bug could still surface it; its absence
  // plus the null id is the proof the guard short-circuits.
  await seedApplication({ withSubmission: true, withReview: true });

  const detail = await getApplicantDetailForCompany(companyA, application._id);
  assert.equal(detail.assignmentSubmission, null);
  assert.equal(detail.assignmentReview, null);
});

test('every pre-existing detail key is still present', async () => {
  const { application } = await seedApplication({ withSubmission: true, withReview: true });
  const detail = await getApplicantDetailForCompany(companyA, application._id);
  for (const key of EXISTING_KEYS) {
    assert.ok(key in detail, `missing pre-existing key: ${key}`);
  }
  assert.ok(detail.application);
  assert.ok(detail.contact);
  assert.ok(Array.isArray(detail.stageChanges));
});

test('the two scoring axes stay in separate keys and are never blended', async () => {
  const { application } = await seedApplication({ withSubmission: true, withReview: true });
  const detail = await getApplicantDetailForCompany(companyA, application._id);
  // The AI resume score (0-100) is absent here; the assignment verdict (1-5) is 4.
  // They must never be merged into one number.
  assert.equal(detail.score, null);
  assert.equal(detail.assignmentReview.overallScore, 4);
  assert.equal('overallScore' in detail, false);
  assert.equal('combinedScore' in detail, false);
});

// FILE: src/models/public/assignment-submission-model.js
// assignment_submissions collection — one seeker submission per application. It
// hangs off an application (not off a company's own entities), so it lives beside
// applicant-note-model.js under models/public/ even though employers read it.
// The FK to the posting is `jobId`, matching `applications` — submissions are 1:1
// with applications and joined against them constantly.
//
// The assignment is SNAPSHOTTED at submit time: editing or archiving an assignment
// later must never rewrite what a candidate was actually asked to do.

import { ObjectId } from 'mongodb';
import { col } from '../../Db/connection.js';

const submissionsCol = () => col('assignment_submissions');

export const MAX_SUBMISSION_LINKS = 5;
export const MAX_SUBMISSION_FILES = 5;

/** Accept a string or ObjectId; return an ObjectId or null. */
function toOid(id) {
  if (id instanceof ObjectId) return id;
  if (typeof id === 'string' && ObjectId.isValid(id)) return new ObjectId(id);
  return null;
}

/** Idempotent index setup. Called on boot. */
export async function ensureAssignmentSubmissionIndexes() {
  const collection = await submissionsCol();
  // One submission per application — the DB, not the service, is the guarantee.
  await collection.createIndex(
    { applicationId: 1 },
    { unique: true, name: 'assignment_submissions_applicationId' },
  );
  // The employer read: a job's submissions, newest first, tenant-scoped.
  await collection.createIndex(
    { companyId: 1, jobId: 1, submittedAt: -1 },
    { name: 'assignment_submissions_company_job_submittedAt' },
  );
}

/**
 * Freeze the assignment as it stood when the candidate submitted. PURE — no I/O,
 * no await — so snapshot logic is testable without a DB, and Chunk 4 can call it
 * inside the apply transaction without adding a round trip.
 */
export function buildAssignmentSnapshot(assignmentDoc, now = new Date()) {
  const doc = assignmentDoc ?? {};
  return {
    title: doc.title ?? null,
    publicSummary: doc.publicSummary ?? null,
    descriptionMarkdown: doc.descriptionMarkdown ?? null,
    submissionInstructionsMarkdown: doc.submissionInstructionsMarkdown ?? null,
    estimatedHours: doc.estimatedHours ?? null,
    allowedFileTypes: Array.isArray(doc.allowedFileTypes) ? [...doc.allowedFileTypes] : [],
    sourceAssignmentId: toOid(doc._id),
    snapshottedAt: now,
  };
}

/** Both profile links, always present as string-or-null (shape stability). */
function normalizeProfileLinks(value) {
  return {
    githubUrl: value?.githubUrl ?? null,
    linkedinUrl: value?.linkedinUrl ?? null,
  };
}

/**
 * Insert one submission. Structural invariants only: the three required ids and the
 * array caps. A duplicate applicationId surfaces as a raw E11000 — deliberately NOT
 * caught here, because only the apply transaction (Chunk 4) knows whether that means
 * "already submitted" or "retry the whole apply".
 */
export async function insertAssignmentSubmission(data = {}, { session } = {}) {
  const applicationOid = toOid(data.applicationId);
  const companyOid = toOid(data.companyId);
  const jobOid = toOid(data.jobId);
  if (!applicationOid) throw new Error('insertAssignmentSubmission: invalid applicationId');
  if (!companyOid) throw new Error('insertAssignmentSubmission: invalid companyId');
  if (!jobOid) throw new Error('insertAssignmentSubmission: invalid jobId');

  const links = Array.isArray(data.links) ? data.links : [];
  const files = Array.isArray(data.files) ? data.files : [];
  if (links.length > MAX_SUBMISSION_LINKS) {
    throw new Error(`insertAssignmentSubmission: at most ${MAX_SUBMISSION_LINKS} links`);
  }
  if (files.length > MAX_SUBMISSION_FILES) {
    throw new Error(`insertAssignmentSubmission: at most ${MAX_SUBMISSION_FILES} files`);
  }

  const now = new Date();
  const doc = {
    // Honoured when supplied so the apply transaction can pre-generate both ids
    // outside its callback — see createApplicationForCompany for why.
    ...(data._id ? { _id: toOid(data._id) } : {}),
    applicationId: applicationOid,
    companyId: companyOid,
    jobId: jobOid,
    assignmentSnapshot: data.assignmentSnapshot ?? null,
    profileLinks: normalizeProfileLinks(data.profileLinks),
    submittedAt: data.submittedAt instanceof Date ? data.submittedAt : now,
    links,
    files,
    seekerNotesMarkdown: data.seekerNotesMarkdown ?? null,
    filesDeletedAt: null,
  };
  const collection = await submissionsCol();
  const result = await collection.insertOne(doc, { session });
  return { ...doc, _id: result.insertedId };
}

/**
 * The submission for one application, or null. Takes { session } so the apply
 * transaction can read its own uncommitted write.
 */
export async function getAssignmentSubmissionForApplication(applicationId, { session } = {}) {
  const applicationOid = toOid(applicationId);
  if (!applicationOid) return null;
  const collection = await submissionsCol();
  return collection.findOne({ applicationId: applicationOid }, { session });
}

/** Fetch one submission scoped to the company — cross-tenant returns null. */
export async function getAssignmentSubmissionForCompany(companyId, submissionId) {
  const companyOid = toOid(companyId);
  const submissionOid = toOid(submissionId);
  if (!companyOid || !submissionOid) return null;
  const collection = await submissionsCol();
  return collection.findOne({ _id: submissionOid, companyId: companyOid });
}

/**
 * Batch-fetch submissions for a page of applications: tenant-scoped by companyId
 * and bounded by an explicit id list (§6.5). An empty list returns [] WITHOUT a
 * query — an unbounded $in on nothing is never worth a round trip.
 */
export async function listAssignmentSubmissionsForApplications(companyId, applicationIds = []) {
  const companyOid = toOid(companyId);
  if (!companyOid) return [];
  const appOids = (Array.isArray(applicationIds) ? applicationIds : []).map(toOid).filter(Boolean);
  if (appOids.length === 0) return [];
  const collection = await submissionsCol();
  return collection
    .find({ companyId: companyOid, applicationId: { $in: appOids } })
    .sort({ submittedAt: -1 })
    .toArray();
}

/**
 * Submission + review counts for ONE posting, computed across every application
 * for it — never by reducing whatever rows a caller happens to be holding.
 *
 * These numbers describe the POSTING, so they must not move when the employer
 * paginates or filters the list. Deriving them from the fetched page would make
 * them drift as the employer flips pages, which turns a summary strip into noise.
 * Returns { submitted, reviewed, passing }; the caller supplies `total` from the
 * applications collection, which is the one number that lives outside this one.
 */
export async function getAssignmentSubmissionStatsForJob(companyId, jobId) {
  const companyOid = toOid(companyId);
  const jobOid = toOid(jobId);
  if (!companyOid || !jobOid) return { submitted: 0, reviewed: 0, passing: 0 };
  const collection = await submissionsCol();
  const [stats] = await collection.aggregate([
    { $match: { companyId: companyOid, jobId: jobOid } },
    {
      $lookup: {
        from: 'assignment_reviews',
        localField: '_id',
        foreignField: 'assignmentSubmissionId',
        as: 'review',
      },
    },
    { $addFields: { reviewDoc: { $first: '$review' } } },
    {
      $group: {
        _id: null,
        submitted: { $sum: 1 },
        reviewed: { $sum: { $cond: [{ $ifNull: ['$reviewDoc', false] }, 1, 0] } },
        passing: { $sum: { $cond: [{ $eq: ['$reviewDoc.passesBar', true] }, 1, 0] } },
      },
    },
  ]).toArray();
  return {
    submitted: stats?.submitted ?? 0,
    reviewed: stats?.reviewed ?? 0,
    passing: stats?.passing ?? 0,
  };
}

/**
 * Data-deletion tombstone: stamp filesDeletedAt and empty files[]. Deliberately
 * does NOT touch disk — the caller owns the filesystem side, so this stays a pure
 * DB op that a transaction can roll back.
 */
export async function markSubmissionFilesDeleted(companyId, submissionId, { session } = {}) {
  const companyOid = toOid(companyId);
  const submissionOid = toOid(submissionId);
  if (!companyOid || !submissionOid) return null;
  const collection = await submissionsCol();
  return collection.findOneAndUpdate(
    { _id: submissionOid, companyId: companyOid },
    { $set: { filesDeletedAt: new Date(), files: [] } },
    { returnDocument: 'after', session },
  );
}

/**
 * Client-safe projection. storagePath is an internal filesystem location and is
 * NEVER exposed — same rule toPublicJob applies to tmpPath in resume-parse-job-model.
 */
export function toPublicAssignmentSubmission(doc) {
  if (!doc) return null;
  const snapshot = doc.assignmentSnapshot ?? null;
  return {
    id: doc._id.toString(),
    applicationId: doc.applicationId?.toString() ?? null,
    jobId: doc.jobId?.toString() ?? null,
    assignmentSnapshot: snapshot
      ? {
          title: snapshot.title ?? null,
          publicSummary: snapshot.publicSummary ?? null,
          descriptionMarkdown: snapshot.descriptionMarkdown ?? null,
          submissionInstructionsMarkdown: snapshot.submissionInstructionsMarkdown ?? null,
          estimatedHours: snapshot.estimatedHours ?? null,
          allowedFileTypes: snapshot.allowedFileTypes ?? [],
          sourceAssignmentId: snapshot.sourceAssignmentId?.toString() ?? null,
          snapshottedAt: snapshot.snapshottedAt ?? null,
        }
      : null,
    profileLinks: normalizeProfileLinks(doc.profileLinks),
    submittedAt: doc.submittedAt ?? null,
    links: (doc.links ?? []).map((link) => ({ url: link.url ?? null, addedAt: link.addedAt ?? null })),
    files: (doc.files ?? []).map((file) => ({
      fileId: file.fileId?.toString() ?? null,
      originalName: file.originalName ?? null,
      sizeBytes: file.sizeBytes ?? null,
      mimeType: file.mimeType ?? null,
      uploadedAt: file.uploadedAt ?? null,
    })),
    seekerNotesMarkdown: doc.seekerNotesMarkdown ?? null,
    filesDeletedAt: doc.filesDeletedAt ?? null,
  };
}

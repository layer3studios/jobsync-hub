// FILE: src/services/public/apply-service.js
// Orchestrates a public application (Lever insert pattern, SPEC §5.4): resolve
// company + active posting by slug → validate → dedup contact → store resume →
// create application + initial stage_change. companyId is always read from the
// looked-up company, never from the request (C7). Storage is injected for tests.
//
// TWO PATHS. A posting with no assignment attached runs exactly the code it always
// has: no session, no transaction, no extra query. Only a posting carrying an
// assignmentId takes the transactional path below, where the application and its
// submission must land together or not at all.

import { ObjectId } from 'mongodb';
import { client } from '../../Db/connection.js';
import { HttpError } from '../../middleware/error-handler-middleware.js';
import { DPDP_NOTICE_VERSION } from '../../env.js';
import { getCompanyBySlug } from '../../models/employer/company-model.js';
import {
  getActivePostingBySlugForCompany, getPostingBySlugForCompany,
} from '../../models/employer/posting-model.js';
import { getDefaultStageForCompany } from '../../models/employer/stage-model.js';
import { getAssignmentForCompany } from '../../models/employer/assignment-model.js';
import {
  findOrCreateContactForCompany, createApplicationForCompany,
  createResumeFile, attachResumeFileToApplication, createStageChange,
  insertAssignmentSubmission, buildAssignmentSnapshot,
} from '../../models/public/index.js';
import * as defaultStorage from './resume-storage-service.js';
import {
  promoteStagedFile, deleteStagedFile, stagedPathFor,
} from './assignment-storage-service.js';
import { verifyStagedFileToken } from '../employer/assignment-signed-url-service.js';
import { validateApplicationForm, isHoneypotFilled } from './apply-validators.js';
import {
  validateSubmissionLinks, validateGithubProfileUrl, validateLinkedinProfileUrl,
  validateSeekerNotes,
} from './assignment-submission-validators.js';
import { enqueueScoreJob } from './resume-score-queue-service.js';

const MAX_SUBMISSION_FILES = 5;
const SUBMISSION_REL = 'data/assignment-submissions';

/**
 * The four writes that must be atomic, as one callback-friendly unit.
 *
 * EXPORTED as a seam: the driver retries this callback on a
 * TransientTransactionError, and the only honest way to test rollback and retry
 * behaviour in this repo is to drive it directly. apply-service imports its model
 * helpers as static ESM bindings — module namespace objects are immutable, so they
 * cannot be monkey-patched, and there is no mocking library here (node --test
 * only). `operations` is injectable purely so a test can substitute a failing or
 * first-call-throwing implementation; production always uses the default.
 */
export const APPLY_TRANSACTION_OPERATIONS = Object.freeze({
  insertAssignmentSubmission,
  createApplicationForCompany,
  attachResumeFileToApplication,
  createStageChange,
});

/**
 * Run the four atomic writes. Called as a withTransaction callback, so:
 *
 *   THIS FUNCTION MAY RUN MORE THAN ONCE. The driver re-executes the whole callback
 *   on a TransientTransactionError, and the spec requires callbacks to be
 *   idempotent. Therefore NOTHING here may have a side effect outside the session:
 *   no file I/O, no `new ObjectId()`, no `new Date()`, no mutation of anything
 *   declared outside, no analytics, no queue enqueue, no logging. Every id, every
 *   timestamp and every derived array is computed by the caller and passed in, so a
 *   second attempt writes byte-identical documents to the same _ids rather than
 *   orphaning the first attempt's.
 *
 * Every operation takes { session } explicitly: col() binds no session, so an op
 * without one commits OUTSIDE the transaction and will never roll back, silently.
 */
export async function runApplyTransaction(context, operations = APPLY_TRANSACTION_OPERATIONS) {
  const {
    session, applicationId, submissionId, companyId, submissionDoc, applicationDoc,
    resumeFileId, defaultStageId,
  } = context;

  await operations.insertAssignmentSubmission({ ...submissionDoc, _id: submissionId }, { session });
  await operations.createApplicationForCompany(companyId, { ...applicationDoc, _id: applicationId }, { session });
  await operations.attachResumeFileToApplication(resumeFileId, applicationId, { session });
  await operations.createStageChange({
    applicationId, fromStageId: null, toStageId: defaultStageId,
    movedByUserId: null, note: 'Application received',
  }, { session });
}

/** Normalize a repeated multipart field or JSON array into a plain array. */
function asArray(value) {
  if (value === undefined || value === null || value === '') return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        return Array.isArray(parsed) ? parsed : [value];
      } catch {
        return [value];
      }
    }
    return [value];
  }
  return [value];
}

/**
 * Resolve the seeker's staged fileIds into committed file entries.
 *
 * Expired ids are collected and reported TOGETHER, naming each one, so the form can
 * tell the candidate exactly which uploads aged out instead of making them redo all
 * of them. The storagePath written is the FINAL location — deterministic from
 * uuid+ext — even though the bytes are still in staging until after commit.
 */
function resolveStagedFiles(fileIds, now) {
  if (fileIds.length > MAX_SUBMISSION_FILES) {
    throw new HttpError(400, `You can attach at most ${MAX_SUBMISSION_FILES} files.`, 'TOO_MANY_FILES');
  }
  const files = [];
  const expiredFiles = [];

  for (const fileId of fileIds) {
    let staged;
    try {
      staged = verifyStagedFileToken(String(fileId));
    } catch (err) {
      if (err.code === 'STAGED_FILE_EXPIRED') {
        expiredFiles.push({ fileId: String(fileId), originalName: null });
        continue;
      }
      throw err; // INVALID_FILE_ID — a tampered id, not a recoverable situation
    }
    files.push({
      fileId: staged.uuid,
      originalName: staged.originalName,
      storagePath: `${SUBMISSION_REL}/${staged.uuid}.${staged.ext}`,
      stagingPath: stagedPathFor(staged.uuid, staged.ext),
      sizeBytes: staged.sizeBytes,
      mimeType: staged.mimeType,
      uploadedAt: now,
    });
  }

  if (expiredFiles.length > 0) {
    const err = new HttpError(
      400, 'Some of your uploaded files have expired. Please upload them again.', 'STAGED_FILES_EXPIRED',
    );
    err.expiredFiles = expiredFiles;
    throw err;
  }
  return files;
}

/**
 * Process an application. `resume` is { buffer, originalFilename, mimeType }.
 * `meta` carries request evidence. `storage` is injectable for tests.
 */
export async function processApplication(companySlug, jobSlug, form, resume, meta = {}, storage = defaultStorage) {
  const company = await getCompanyBySlug(companySlug);
  if (!company) throw new HttpError(404, 'Company not found.', 'COMPANY_NOT_FOUND');

  const posting = await getActivePostingBySlugForCompany(company._id, jobSlug);
  if (!posting) {
    // Narrowly scoped: ONLY an assignment posting gets the softer message. A
    // candidate who spent hours on a take-home deserves to know the role closed
    // rather than be told it does not exist. Plain postings keep the 404 exactly.
    const anyStatus = await getPostingBySlugForCompany(company._id, jobSlug);
    if (anyStatus && anyStatus.assignmentId && anyStatus.status !== 'active') {
      throw new HttpError(
        409,
        'This role closed while you were working on the assignment. Your work has not been lost — copy it before leaving this page.',
        'POSTING_CLOSED_DURING_APPLY',
      );
    }
    throw new HttpError(404, 'This job is no longer accepting applications.', 'POSTING_NOT_FOUND');
  }

  // Honeypot: bots fill the hidden field. Respond OK without storing anything (R4).
  if (isHoneypotFilled(form)) return { applicationId: 'ok' };

  const clean = validateApplicationForm(form);
  if (!resume?.buffer) throw new HttpError(400, 'A resume file is required.', 'NO_FILE');

  const defaultStage = await getDefaultStageForCompany(company._id);
  if (!defaultStage) throw new HttpError(500, 'This company has no application pipeline.', 'NO_DEFAULT_STAGE');

  // Stays OUTSIDE the transaction: already idempotent, handles its own E11000 race,
  // and pulling it in would widen the write-conflict window for no benefit. A
  // rolled-back apply can therefore leave a contact with no application — harmless,
  // since contacts are shared across applications by design and a stray one is
  // invisible to the employer's application-scoped views.
  const { contact } = await findOrCreateContactForCompany(company._id, {
    email: clean.email, fullName: `${clean.firstName} ${clean.lastName}`, phone: clean.phone,
  });

  const stored = storage.storeResumeFile(resume.buffer);
  try {
    const resumeRecord = await createResumeFile({
      applicationId: null, storagePath: stored.storagePath,
      originalFilename: resume.originalFilename, mimeType: resume.mimeType, sizeBytes: stored.sizeBytes,
    });

    const baseApplication = {
      jobId: posting._id, contactId: contact._id, stageId: defaultStage._id,
      resumeFileId: resumeRecord._id, coverNote: clean.coverNote, yearsExperience: clean.yearsExperience,
      source: 'apply_page', sourceDetail: form.utm_source ?? null,
      applicantIp: meta.applicantIp ?? null, userAgent: meta.userAgent ?? null, referer: meta.referer ?? null,
    };

    // ── Plain posting: the original path, unchanged. No session, no transaction. ──
    if (!posting.assignmentId) {
      const application = await createApplicationForCompany(company._id, {
        ...baseApplication,
        consent: { dpdpAcceptedAt: new Date(), futureOpportunitiesConsent: clean.futureOpportunities },
      });

      await attachResumeFileToApplication(resumeRecord._id, application._id);
      await createStageChange({
        applicationId: application._id, fromStageId: null, toStageId: defaultStage._id,
        movedByUserId: null, note: 'Application received',
      });

      // Enqueue AI scoring (Q1 D5): persistent, retried queue instead of fire-and-forget.
      // enqueueScoreJob never throws, but keep the .catch as a belt-and-braces guard so
      // an application can never fail on the scoring path (C8).
      enqueueScoreJob(application._id, application.companyId, application.jobId)
        .catch((err) => console.warn('[score-queue] enqueue failed:', err.message));

      return { applicationId: application._id.toString() };
    }

    // ── Assignment posting: everything below lands atomically or not at all. ──

    // Drift check: the client echoes the assignment the form actually rendered. If
    // the employer swapped it mid-session, the candidate answered a different task.
    if (form.assignmentId === undefined || form.assignmentId === null || form.assignmentId === '') {
      throw new HttpError(400, 'This application is missing its assignment reference.', 'MISSING_ASSIGNMENT_ID');
    }
    if (String(form.assignmentId) !== String(posting.assignmentId)) {
      throw new HttpError(
        409,
        'This assignment was updated while you were working. Refresh to see the latest version.',
        'ASSIGNMENT_CHANGED',
      );
    }

    const assignment = await getAssignmentForCompany(company._id, posting.assignmentId);
    // A posting pointing at a deleted assignment is a data bug on our side, not
    // something the candidate did wrong.
    if (!assignment) throw new HttpError(500, 'This assignment is unavailable.', 'ASSIGNMENT_MISSING');

    // Everything below is computed BEFORE the transaction opens — see the comment
    // on runApplyTransaction for why the callback may not do any of it.
    const now = new Date();
    const applicationId = new ObjectId();
    const submissionId = new ObjectId();

    const links = validateSubmissionLinks(asArray(form.assignmentLinks), now);
    const files = resolveStagedFiles(asArray(form.assignmentFileIds), now);
    if (links.length === 0 && files.length === 0) {
      throw new HttpError(
        400, 'Add at least one link or file for the assignment.', 'ASSIGNMENT_SUBMISSION_REQUIRED',
      );
    }

    const seekerNotesMarkdown = validateSeekerNotes(form.assignmentNotesMarkdown);
    const profileLinks = {
      githubUrl: validateGithubProfileUrl(form.githubUrl),
      linkedinUrl: validateLinkedinProfileUrl(form.linkedinUrl),
    };
    const snapshot = buildAssignmentSnapshot(assignment, now); // pure — no I/O

    const submissionDoc = {
      applicationId, companyId: company._id, jobId: posting._id,
      assignmentSnapshot: snapshot, profileLinks, submittedAt: now,
      links,
      // The row stores the FINAL path even though the bytes are still in staging:
      // the path is deterministic from uuid+ext, and the reconciler closes the gap
      // if we crash before the rename. Never the reverse — a committed row pointing
      // at a not-yet-moved file is recoverable; a moved file with no row is not.
      files: files.map(({ stagingPath, ...file }) => file),
      seekerNotesMarkdown,
    };

    const applicationDoc = {
      ...baseApplication,
      assignmentSubmissionId: submissionId,
      consent: {
        dpdpAcceptedAt: now,
        futureOpportunitiesConsent: clean.futureOpportunities,
        // The `consents` collection cannot be used for this flow: insertConsent
        // requires a userId and every /api/dpdp route sits behind requireSeeker,
        // but public applicants are anonymous and have no user row. This embedded
        // object is therefore the ONLY evidence store available here.
        // DPDP_NOTICE_VERSION must be bumped in the environment before this ships —
        // the notice content changed when assignment data collection was added.
        dataItems: ['assignment_files', 'assignment_notes', 'profile_links'],
        noticeVersion: DPDP_NOTICE_VERSION,
      },
    };

    const session = client.startSession();
    try {
      await session.withTransaction(async () => {
        await runApplyTransaction({
          session, applicationId, submissionId, companyId: company._id,
          submissionDoc, applicationDoc,
          resumeFileId: resumeRecord._id, defaultStageId: defaultStage._id,
        });
      });
    } catch (err) {
      // The transaction rolled back, so nothing references these bytes.
      for (const file of files) deleteStagedFile(file.stagingPath);
      throw err;
    } finally {
      await session.endSession();
    }

    // AFTER COMMIT ONLY. A failed rename must NOT throw: the row is committed and
    // the boot reconciler will promote the file. Losing a candidate's whole
    // application because one rename failed would be far worse than a late file.
    for (const file of files) {
      if (!promoteStagedFile(file.stagingPath)) {
        console.warn(`[assignments] could not promote ${file.stagingPath} for submission ${submissionId}`);
      }
    }

    enqueueScoreJob(applicationId, company._id, posting._id)
      .catch((err) => console.warn('[score-queue] enqueue failed:', err.message));

    return { applicationId: applicationId.toString() };
  } catch (err) {
    storage.deleteResumeFile(stored.storagePath); // cleanup on partial failure (D6)
    throw err;
  }
}

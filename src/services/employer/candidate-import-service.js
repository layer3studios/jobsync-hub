// FILE: src/services/employer/candidate-import-service.js
// The shared half of bulk candidate import: create one candidate on a posting from
// an already-parsed row, and the per-batch bookkeeping both import methods report.
//
// A batch NEVER fails as a whole. One corrupt PDF or one malformed CSV row is that
// row's problem: it lands in errors[] with a reason a recruiter can act on, and the
// import keeps going. The summary is the deliverable, not an exception.

import { findOrCreateContactForCompany } from '../../models/public/contact-model.js';
import { createApplicationForCompany } from '../../models/public/application-model.js';
import { createStageChange } from '../../models/public/stage-change-model.js';
import { createResumeFile, attachResumeFileToApplication } from '../../models/public/resume-file-model.js';
import { getDefaultStageForCompany } from '../../models/employer/stage-model.js';
import { storeResumeFile, deleteResumeFile } from '../public/resume-storage-service.js';
import { enqueueScoreJob } from '../public/resume-score-queue-service.js';
import { HttpError } from '../../middleware/error-handler-middleware.js';
import { col } from '../../Db/connection.js';
import { createTag, normalizeTagName, TAGS_PER_APPLICATION_MAX } from '../../models/employer/candidate-tag-model.js';

export const MAX_IMPORT_FILES = 200;
export const IMPORT_SOURCE = 'bulk-import';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export const isValidEmail = (value) => EMAIL_PATTERN.test(String(value ?? '').trim());

/** Running totals plus the per-file reasons. One per import request. */
export function createImportSummary() {
  return { imported: 0, duplicates: 0, failed: 0, errors: [], seenEmails: new Set() };
}

/** Record a skipped/failed file without letting it stop the batch. */
export function recordFailure(summary, filename, reason) {
  summary.failed += 1;
  summary.errors.push({ filename, reason });
}

/** The summary shape the API returns — the internal dedup set never ships. */
export function toPublicSummary(summary) {
  return {
    imported: summary.imported,
    duplicates: summary.duplicates,
    failed: summary.failed,
    errors: summary.errors.slice(0, 100),
  };
}

/** The stage imported candidates land in — the same one the apply flow uses. */
export async function requireDefaultStage(companyId) {
  const stage = await getDefaultStageForCompany(companyId);
  if (!stage) throw new HttpError(400, 'This company has no application pipeline.', 'NO_DEFAULT_STAGE');
  return stage;
}

/**
 * Create one imported candidate: contact (deduped by email within the company),
 * application on the posting, initial stage change, optional resume + scoring job.
 *
 * DEDUP HAS TWO LAYERS and they mean different things. Within one batch, a repeated
 * email is a duplicate FILE — the archive held the same person twice, so the second
 * copy is skipped outright. Across batches, an existing contact is reused (that is
 * what a contact is for) but a second application to the SAME posting is a duplicate.
 */
/**
 * Put every imported tag into the company's library before it lands on an
 * application. Without this, a CSV could write a name the library has never heard
 * of — and the next time someone edited that candidate's tags, the whole list
 * would be refused as unknown.
 */
async function registerImportedTags(companyId, tags) {
  const names = [...new Set((tags ?? []).map(normalizeTagName).filter(Boolean))]
    .slice(0, TAGS_PER_APPLICATION_MAX);
  for (const name of names) {
    await createTag(companyId, name);
  }
  return names;
}

export async function importCandidate(companyId, posting, stage, row, { resume = null } = {}) {
  const email = String(row.email).trim().toLowerCase();

  const { contact } = await findOrCreateContactForCompany(companyId, {
    email,
    fullName: [row.firstName, row.lastName].filter(Boolean).join(' ').trim() || null,
    phone: row.phone ?? null,
  });

  // Already applied to this posting — reuse nothing, create nothing.
  const applications = await col('applications');
  const existing = await applications.findOne({
    companyId: contact.companyId, jobId: posting._id, contactId: contact._id,
  });
  if (existing) return { status: 'duplicate' };

  const tags = await registerImportedTags(companyId, row.tags);

  let resumeRecord = null;
  let storedPath = null;
  if (resume?.buffer?.length) {
    const stored = storeResumeFile(resume.buffer);
    storedPath = stored.storagePath;
    resumeRecord = await createResumeFile({
      applicationId: null,
      storagePath: stored.storagePath,
      originalFilename: resume.filename ?? null,
      mimeType: 'application/pdf',
      sizeBytes: stored.sizeBytes,
    });
  }

  try {
    const application = await createApplicationForCompany(companyId, {
      jobId: posting._id,
      contactId: contact._id,
      stageId: stage._id,
      source: IMPORT_SOURCE,
      sourceDetail: row.sourceDetail ?? resume?.filename ?? null,
      resumeFileId: resumeRecord?._id ?? null,
      tags,
    });
    if (resumeRecord) await attachResumeFileToApplication(resumeRecord._id, application._id);
    await createStageChange({
      applicationId: application._id,
      fromStageId: null, toStageId: stage._id,
      movedByUserId: null,
      note: 'Imported',
    });
    // Fire-and-forget, exactly as the apply flow does: scoring is never a gate on
    // the candidate existing.
    if (resumeRecord) {
      enqueueScoreJob(application._id, companyId, posting._id)
        .catch((err) => console.warn('[import] score enqueue failed:', err.message));
    }
    return { status: 'imported', applicationId: application._id };
  } catch (err) {
    // The application never landed, so nothing references these bytes.
    if (storedPath) deleteResumeFile(storedPath);
    throw err;
  }
}

/**
 * Run one parsed row through import, translating every outcome into summary
 * bookkeeping. Returns nothing — the summary IS the result.
 */
export async function applyRowToSummary(summary, companyId, posting, stage, row, options = {}) {
  const email = String(row.email ?? '').trim().toLowerCase();
  if (summary.seenEmails.has(email)) {
    summary.duplicates += 1;
    return;
  }
  summary.seenEmails.add(email);
  try {
    const result = await importCandidate(companyId, posting, stage, { ...row, email }, options);
    if (result.status === 'duplicate') summary.duplicates += 1;
    else summary.imported += 1;
  } catch (err) {
    recordFailure(summary, row.filename ?? email, err.message || 'Could not import this candidate.');
  }
}

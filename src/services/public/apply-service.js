// FILE: src/services/public/apply-service.js
// Orchestrates a public application (Lever insert pattern, SPEC §5.4): resolve
// company + active posting by slug → validate → dedup contact → store resume →
// create application + initial stage_change. companyId is always read from the
// looked-up company, never from the request (C7). Storage is injected for tests.

import { HttpError } from '../../middleware/error-handler-middleware.js';
import { getCompanyBySlug } from '../../models/employer/company-model.js';
import { getActivePostingBySlugForCompany } from '../../models/employer/posting-model.js';
import { getDefaultStageForCompany } from '../../models/employer/stage-model.js';
import {
  findOrCreateContactForCompany, createApplicationForCompany,
  createResumeFile, attachResumeFileToApplication, createStageChange,
} from '../../models/public/index.js';
import * as defaultStorage from './resume-storage-service.js';
import { validateApplicationForm, isHoneypotFilled } from './apply-validators.js';
import { enqueueScoreJob } from './resume-score-queue-service.js';

/**
 * Process an application. `resume` is { buffer, originalFilename, mimeType }.
 * `meta` carries request evidence. `storage` is injectable for tests.
 */
export async function processApplication(companySlug, jobSlug, form, resume, meta = {}, storage = defaultStorage) {
  const company = await getCompanyBySlug(companySlug);
  if (!company) throw new HttpError(404, 'Company not found.', 'COMPANY_NOT_FOUND');

  const posting = await getActivePostingBySlugForCompany(company._id, jobSlug);
  if (!posting) throw new HttpError(404, 'This job is no longer accepting applications.', 'POSTING_NOT_FOUND');

  // Honeypot: bots fill the hidden field. Respond OK without storing anything (R4).
  if (isHoneypotFilled(form)) return { applicationId: 'ok' };

  const clean = validateApplicationForm(form);
  if (!resume?.buffer) throw new HttpError(400, 'A resume file is required.', 'NO_FILE');

  const defaultStage = await getDefaultStageForCompany(company._id);
  if (!defaultStage) throw new HttpError(500, 'This company has no application pipeline.', 'NO_DEFAULT_STAGE');

  const { contact } = await findOrCreateContactForCompany(company._id, {
    email: clean.email, fullName: `${clean.firstName} ${clean.lastName}`, phone: clean.phone,
  });

  const stored = storage.storeResumeFile(resume.buffer);
  try {
    const resumeRecord = await createResumeFile({
      applicationId: null, storagePath: stored.storagePath,
      originalFilename: resume.originalFilename, mimeType: resume.mimeType, sizeBytes: stored.sizeBytes,
    });

    const application = await createApplicationForCompany(company._id, {
      jobId: posting._id, contactId: contact._id, stageId: defaultStage._id,
      resumeFileId: resumeRecord._id, coverNote: clean.coverNote, yearsExperience: clean.yearsExperience,
      source: 'apply_page', sourceDetail: form.utm_source ?? null,
      consent: { dpdpAcceptedAt: new Date(), futureOpportunitiesConsent: clean.futureOpportunities },
      applicantIp: meta.applicantIp ?? null, userAgent: meta.userAgent ?? null, referer: meta.referer ?? null,
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
  } catch (err) {
    storage.deleteResumeFile(stored.storagePath); // cleanup on partial failure (D6)
    throw err;
  }
}

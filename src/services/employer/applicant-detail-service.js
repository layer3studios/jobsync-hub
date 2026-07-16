// FILE: src/services/employer/applicant-detail-service.js
// Composes the full applicant detail view (D2): application + contact + AI score +
// stage-change history + resume metadata + a signed download URL. Every read is
// companyId-scoped (§6.5); a cross-tenant applicationId surfaces as 404, never a
// leak. The download URL is a short-lived signed token (no auth cookie needed to
// open the PDF inline) built by the signed-url service.

import { HttpError } from '../../middleware/error-handler-middleware.js';
import { getApplicationForCompany } from '../../models/public/application-model.js';
import { getContactForCompany, toPublicContact } from '../../models/public/contact-model.js';
import { getResumeScoreForApplication, toPublicResumeScore } from '../../models/public/resume-score-model.js';
import { listStageChangesForApplication } from '../../models/public/stage-change-model.js';
import { getResumeFileForApplication } from '../../models/public/resume-file-model.js';
import { getScoreJobStatusForApplication } from '../public/resume-score-queue-service.js';
import { toEmployerApplication, toEmployerStageChange, toResumeMeta } from './applicant-mappers.js';
import { signResumeToken } from './signed-url-service.js';

/** Assemble every section of one applicant's detail page for the owning company. */
export async function getApplicantDetailForCompany(companyId, applicationId) {
  const application = await getApplicationForCompany(companyId, applicationId);
  if (!application) throw new HttpError(404, 'Application not found', 'APPLICATION_NOT_FOUND');

  const contact = await getContactForCompany(companyId, application.contactId);
  const score = await getResumeScoreForApplication(application._id);
  const stageChanges = await listStageChangesForApplication(application._id);
  const resumeFile = await getResumeFileForApplication(application._id);
  // Queue lifecycle, separate axis from score.processingError — lets the UI show
  // "Rescoring…" while a job is queued/processing. null when no job doc exists.
  const scoreJobStatus = await getScoreJobStatusForApplication(application._id);

  const resumeMeta = resumeFile ? toResumeMeta(resumeFile) : null;
  const resumeDownloadUrl = resumeMeta
    ? `/api/public/resume-download?token=${signResumeToken(application._id)}`
    : null;

  return {
    application: toEmployerApplication(application),
    contact: contact ? toPublicContact(contact) : null,
    score: score ? toPublicResumeScore(score) : null,
    scoreJobStatus,
    stageChanges: stageChanges.map(toEmployerStageChange),
    resumeMeta,
    resumeDownloadUrl,
  };
}

export default getApplicantDetailForCompany;

// FILE: src/services/employer/candidate-export-service.js
// Everything JobMesh holds about one candidate on one application, as one document.
//
// TWO AUDIENCES, ONE BUILDER. An employer export is the full record. A candidate
// export (DPDP right of access) is the same record minus the parts that are the
// EMPLOYER's data rather than the candidate's: internal notes, AI score reasoning,
// interviewer feedback. Those are opinions formed about a person, not information
// they supplied, and handing them over would turn a data-access right into a
// discovery mechanism. The `audience` argument is the whole difference — there is no
// second code path to drift out of sync.
//
// An anonymized candidate exports their anonymized record. That is not a bug to
// paper over: the data is gone, and the export saying so is the honest answer.

import { HttpError } from '../../middleware/error-handler-middleware.js';
import { getApplicationForCompany } from '../../models/public/application-model.js';
import { getContactForCompany } from '../../models/public/contact-model.js';
import { getPostingForCompany } from '../../models/employer/posting-model.js';
import { getResumeScoreForApplication } from '../../models/public/resume-score-model.js';
import { listApplicantNotesForApplication } from '../../models/public/applicant-note-model.js';
import { listStageChangesForApplication } from '../../models/public/stage-change-model.js';
import { listStagesForCompany } from '../../models/employer/stage-model.js';
import { listInterviewsForApplication } from '../../models/interview/interview-model.js';

export const EXPORT_AUDIENCES = Object.freeze({ EMPLOYER: 'employer', CANDIDATE: 'candidate' });

/** Interview rows the candidate took part in — what happened, not what was thought. */
function toInterviewEntry(interview, includeFeedback) {
  return {
    scheduledFor: interview.startAtUtc ?? null,
    timezone: interview.timezoneId ?? null,
    durationMinutes: interview.durationMinutes ?? null,
    mode: interview.mode ?? null,
    status: interview.status ?? null,
    cancelledAt: interview.cancelledAt ?? null,
    completedAt: interview.completedAt ?? null,
    ...(includeFeedback
      ? { recommendation: interview.recommendation ?? null, feedback: interview.feedbackText ?? null }
      : {}),
  };
}

/**
 * Build the export document. Throws 404 for an unknown or cross-tenant application.
 *
 * `generatedAt` is stamped here rather than by the caller so every copy of an export
 * — file, email attachment, API response — carries the same provenance line.
 */
export async function buildCandidateExport(companyId, applicationId, { audience = EXPORT_AUDIENCES.EMPLOYER } = {}) {
  const application = await getApplicationForCompany(companyId, applicationId);
  if (!application) throw new HttpError(404, 'Application not found', 'APPLICATION_NOT_FOUND');
  const isEmployerExport = audience === EXPORT_AUDIENCES.EMPLOYER;

  const [contact, posting, score, notes, stageChanges, stages, interviews] = await Promise.all([
    getContactForCompany(companyId, application.contactId),
    getPostingForCompany(companyId, application.jobId),
    getResumeScoreForApplication(application._id),
    listApplicantNotesForApplication(companyId, application._id),
    listStageChangesForApplication(application._id),
    listStagesForCompany(companyId),
    listInterviewsForApplication(companyId, application._id),
  ]);

  const stageNameById = new Map(stages.map((stage) => [stage._id.toString(), stage.text]));
  const nameOf = (stageId) => (stageId ? stageNameById.get(stageId.toString()) ?? null : null);

  return {
    generatedAt: new Date(),
    audience,
    contact: {
      fullName: contact?.fullName ?? null,
      email: contact?.email ?? null,
      phone: contact?.phone ?? null,
      location: contact?.location ?? null,
      linkedinUrl: contact?.linkedinUrl ?? null,
      githubUrl: contact?.githubUrl ?? null,
      portfolioUrl: contact?.portfolioUrl ?? null,
      firstSeenAt: contact?.firstSeenAt ?? null,
    },
    application: {
      postingTitle: posting?.title ?? null,
      currentStage: nameOf(application.stageId),
      appliedAt: application.appliedAt ?? null,
      source: application.source ?? null,
      coverNote: application.coverNote ?? null,
      yearsExperience: application.yearsExperience ?? null,
      // Recruiter-applied labels: employer commentary, withheld from the candidate copy.
      ...(isEmployerExport ? { tags: application.tags ?? [] } : {}),
      archived: application.archived
        ? { at: application.archived.at ?? null, note: application.archived.note ?? null }
        : null,
      consent: application.consent ?? null,
    },
    // The AI score's numbers describe the candidate's own resume, so they travel.
    // The explanation is generated commentary about them, so it does not.
    score: score
      ? {
          score: score.score ?? null,
          tier: score.tier ?? null,
          matchedSkills: score.matchedSkills ?? [],
          missingSkills: score.missingSkills ?? [],
          bonusSkills: score.bonusSkills ?? [],
          processedAt: score.processedAt ?? null,
          ...(isEmployerExport ? { explanation: score.explanation ?? null } : {}),
        }
      : null,
    notes: isEmployerExport
      ? notes.map((note) => ({
          body: note.body,
          authorName: note.authorName ?? null,
          createdAt: note.createdAt,
        }))
      : [],
    stageHistory: stageChanges.map((change) => ({
      from: nameOf(change.fromStageId),
      to: nameOf(change.toStageId),
      note: change.note ?? null,
      movedAt: change.movedAt ?? null,
    })),
    interviews: interviews.map((interview) => toInterviewEntry(interview, isEmployerExport)),
  };
}

/** "Alex Kumar" → "alex-kumar"; blank → "candidate". Safe for a filename. */
export function exportFilenameSlug(name) {
  const slug = String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return slug || 'candidate';
}

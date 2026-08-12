// FILE: src/services/employer/candidate-anonymize-service.js
// Employer-initiated erasure: the housekeeping path, for when a candidate emails the
// recruiter directly instead of filing a formal rights request.
//
// It does exactly what DPDP fulfilment does — anonymize-candidate-service is shared,
// not reimplemented — but scoped to the one company doing the asking, and gated on
// Owner+ at the route.
//
// THE PREVIEW EXISTS BECAUSE THE ACTION IS IRREVERSIBLE AND WIDER THAN IT LOOKS. An
// employer opens ONE application and presses a button that reaches every application
// that person ever made here. The dialog has to say so, and it can only say so if
// the server counts first.

import { HttpError } from '../../middleware/error-handler-middleware.js';
import { getApplicationForCompany, listApplicationsForContact } from '../../models/public/application-model.js';
import { getContactForCompany } from '../../models/public/contact-model.js';
import { isContactAnonymized } from '../../models/public/contact-anonymization-model.js';
import { listInterviewsForApplication } from '../../models/interview/interview-model.js';
import { INTERVIEW_STATUSES } from '../../models/interview/interview-constants.js';
import { anonymizeCandidateForCompany } from '../dpdp/anonymize-candidate-service.js';

/** The application + its contact, or 404 — cross-tenant is indistinguishable from missing. */
async function requireApplicationAndContact(companyId, applicationId) {
  const application = await getApplicationForCompany(companyId, applicationId);
  if (!application) throw new HttpError(404, 'Application not found', 'APPLICATION_NOT_FOUND');
  const contact = await getContactForCompany(companyId, application.contactId);
  if (!contact) throw new HttpError(404, 'Candidate not found', 'CONTACT_NOT_FOUND');
  return { application, contact };
}

/**
 * What anonymizing this candidate would touch.
 *
 * Scheduled interviews are surfaced but NOT cancelled. Anonymizing strips the
 * candidate's contact details, which is precisely what a cancellation email would
 * need — so cancelling afterwards is impossible and cancelling automatically would
 * be a decision this action has no business making. The UI warns; the employer
 * cancels first if they mean to.
 */
export async function previewCandidateAnonymization(companyId, applicationId) {
  const { application, contact } = await requireApplicationAndContact(companyId, applicationId);
  const applications = await listApplicationsForContact(companyId, contact._id);

  const interviewLists = await Promise.all(
    applications.map((app) => listInterviewsForApplication(companyId, app._id)),
  );
  const upcomingInterviews = interviewLists.flat()
    .filter((interview) => interview.status === INTERVIEW_STATUSES.SCHEDULED && interview.startAtUtc)
    .map((interview) => ({
      id: interview._id.toString(),
      startAtUtc: interview.startAtUtc,
      timezoneId: interview.timezoneId ?? null,
    }))
    .sort((first, second) => new Date(first.startAtUtc) - new Date(second.startAtUtc));

  return {
    applicationId: application._id.toString(),
    candidateName: contact.fullName ?? null,
    applicationCount: applications.length,
    alreadyAnonymized: isContactAnonymized(contact),
    upcomingInterviews,
  };
}

/**
 * Anonymize the candidate behind one application, company-wide. Idempotent — a
 * second call returns alreadyAnonymized: true and writes nothing.
 */
export async function anonymizeCandidateForApplication(companyId, applicationId, actorEmployerUserId) {
  const { contact } = await requireApplicationAndContact(companyId, applicationId);
  return anonymizeCandidateForCompany(companyId, contact._id, {
    actor: { type: 'employer', id: actorEmployerUserId ?? null },
  });
}

// FILE: src/services/interview/interview-context-helpers.js
// Builds the email context every interview notification needs, always from the
// interview's OWN companyId — never from caller-supplied values. Shared by the
// scheduling, booking and cancel services. Dependencies are injectable so tests
// never touch the network (DB reads stay real under test-db).

import { getCompanyById as defaultGetCompanyById } from '../../models/employer/company-model.js';
import { getPostingForCompany as defaultGetPostingForCompany } from '../../models/employer/posting-model.js';
import { getContactForCompany as defaultGetContactForCompany } from '../../models/public/contact-model.js';
import { getEmployerUserById as defaultGetEmployerUserById } from '../../models/employer/employer-user-model.js';

/** Emails for a set of employer user ids; unknown ids are skipped. */
export async function resolveInterviewerEmails(interviewerEmployerUserIds, deps = {}) {
  const { getEmployerUserById = defaultGetEmployerUserById } = deps;
  const users = await Promise.all((interviewerEmployerUserIds ?? []).map((id) => getEmployerUserById(id)));
  return users.map((user) => user?.email).filter(Boolean);
}

/**
 * The full context the notification service consumes:
 * { interview, companyName, companyLogoUrl, postingTitle, candidateName,
 *   candidateEmail, organizerName, organizerEmail, interviewerEmails }.
 * Returns null when any required related record is missing.
 */
export async function buildInterviewEmailContext(interview, deps = {}) {
  const {
    getCompanyById = defaultGetCompanyById,
    getPostingForCompany = defaultGetPostingForCompany,
    getContactForCompany = defaultGetContactForCompany,
    getEmployerUserById = defaultGetEmployerUserById,
  } = deps;

  const [company, posting, contact, organizer] = await Promise.all([
    getCompanyById(interview.companyId),
    getPostingForCompany(interview.companyId, interview.postingId),
    getContactForCompany(interview.companyId, interview.contactId),
    getEmployerUserById(interview.createdByEmployerUserId),
  ]);
  if (!company || !posting || !contact) return null;

  return {
    interview,
    companyName: company.name,
    companyLogoUrl: company.logoUrl ?? null,
    postingTitle: posting.title,
    candidateName: contact.fullName || contact.email,
    candidateEmail: contact.email,
    organizerName: organizer?.name || company.name,
    organizerEmail: organizer?.email || company.dpoEmail || '',
    interviewerEmails: await resolveInterviewerEmails(interview.interviewerEmployerUserIds, deps),
  };
}

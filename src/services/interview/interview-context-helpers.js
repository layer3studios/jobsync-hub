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
  const recipients = await resolveInterviewerRecipients(interviewerEmployerUserIds, deps);
  return recipients.map((recipient) => recipient.email);
}

/**
 * The same people, but as { employerUserId, email } pairs.
 *
 * The id has to survive alongside the address because notification preferences are
 * per USER, and an email string cannot be asked whether its owner wants this event.
 * resolveInterviewerEmails is kept as the thin projection so existing callers and
 * tests are untouched.
 */
export async function resolveInterviewerRecipients(interviewerEmployerUserIds, deps = {}) {
  const { getEmployerUserById = defaultGetEmployerUserById } = deps;
  const users = await Promise.all((interviewerEmployerUserIds ?? []).map((id) => getEmployerUserById(id)));
  return users
    .filter((user) => user?.email)
    .map((user) => ({ employerUserId: user._id, email: user.email }));
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

  const interviewerRecipients = await resolveInterviewerRecipients(
    interview.interviewerEmployerUserIds, deps,
  );

  return {
    interview,
    companyName: company.name,
    companyLogoUrl: company.logoUrl ?? null,
    postingTitle: posting.title,
    candidateName: contact.fullName || contact.email,
    candidateEmail: contact.email,
    candidatePhone: contact.phone ?? null, // phone-mode "we call you" emails
    organizerName: organizer?.name || company.name,
    organizerEmail: organizer?.email || company.dpoEmail || '',
    // Both shapes: `interviewerEmails` is what the templates and existing callers
    // read, `interviewerRecipients` is what the notification gate needs.
    interviewerEmails: interviewerRecipients.map((recipient) => recipient.email),
    interviewerRecipients,
  };
}

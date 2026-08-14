// FILE: src/services/employer/new-application-notification-service.js
// "Priya Raman applied to Backend Engineer." — the team-facing counterpart to the
// candidate's confirmation email.
//
// This notification did not exist before. Nobody at the company was told when an
// application arrived; you found out by opening the pipeline. So the gate this
// introduces is not switching off an old behaviour — it is the on-switch for a new
// one, defaulted on and easy to mute.
//
// WHO GETS IT: every current member of the company who has newApplication enabled.
// Not "the posting owner", because postings do not have owners in this model — a
// company_members row is the only real answer to "who works here".
//
// FIRE-AND-FORGET, ALWAYS. By the time this runs the application is committed. It
// never throws, never rejects, and is never awaited on the apply path: a mail
// outage must cost the team a notification, never the candidate their application.

import { FRONTEND_URL } from '../../env.js';
import { findCompanyMembersByCompanyId } from '../../models/employer/company-member-model.js';
import { getEmployerUserById } from '../../models/employer/employer-user-model.js';
import { sendTransactionalEmail } from '../email/send-email-service.js';
import { buildNewApplicationEmail } from '../email/templates/new-application-template.js';
import { filterRecipientsByPreference } from './notification-gate-service.js';

/** Every member of the company as { employerUserId, email }; unknown ids skipped. */
async function companyRecipients(companyId) {
  const members = await findCompanyMembersByCompanyId(companyId);
  const users = await Promise.all(members.map((member) => getEmployerUserById(member.employerUserId)));
  return users
    .filter((user) => user?.email)
    .map((user) => ({ employerUserId: user._id, email: user.email }));
}

/**
 * Notify the team about one new application. Returns { notified } for tests; callers
 * on the apply path use queueNewApplicationNotification instead.
 */
export async function sendNewApplicationNotifications({
  companyId, companyName, postingId, postingTitle, applicationId, candidateName,
}) {
  const recipients = await companyRecipients(companyId);
  const allowed = await filterRecipientsByPreference(recipients, 'newApplication');
  if (allowed.length === 0) return { notified: 0 };

  const email = buildNewApplicationEmail({
    candidateName: candidateName || 'A candidate',
    postingTitle: postingTitle || 'a posting',
    companyName: companyName || 'your company',
    applicantUrl: `${FRONTEND_URL}/employer/jobs/${postingId}/applicants/${applicationId}`,
  });

  const results = await Promise.all(allowed.map(async (recipient) => {
    const outcome = await sendTransactionalEmail({ to: recipient.email, ...email });
    return outcome.sent;
  }));
  return { notified: results.filter(Boolean).length };
}

/**
 * Fire-and-forget wrapper. Exists so call sites read as a deliberate non-awaited
 * side effect rather than a floating promise someone later "fixes" by adding an
 * await that would put a fan-out of emails on the apply response path.
 */
export function queueNewApplicationNotification(input) {
  void sendNewApplicationNotifications(input)
    .catch((err) => console.warn(`[new-application-notify] failed: ${err.message}`));
}

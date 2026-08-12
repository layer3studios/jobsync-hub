// FILE: src/services/employer/note-mention-service.js
// Resolving and notifying @mentions on an applicant note.
//
// TRUST NOTHING FROM THE CLIENT. The frontend runs the @autocomplete and sends the
// ids it resolved, but this service re-derives the allowed set from company_members
// and keeps only the intersection. An id for a teammate at another company, or for
// someone who has since been removed, is silently dropped rather than 400'd — the
// note itself is the user's work and must not be lost to a stale roster.
//
// The author is always dropped: nobody needs an email telling them what they just
// wrote. Sends are fire-and-forget (sendTransactionalEmail never rejects), so a
// dead mail provider can never fail a note save.

import { FRONTEND_URL } from '../../env.js';
import { findCompanyMembersByCompanyId } from '../../models/employer/company-member-model.js';
import { getEmployerUserById } from '../../models/employer/employer-user-model.js';
import { getPostingForCompany } from '../../models/employer/posting-model.js';
import { getContactForCompany } from '../../models/public/contact-model.js';
import { sendTransactionalEmail } from '../email/send-email-service.js';
import { buildNoteMentionEmail, buildNotePreview } from '../email/templates/note-mention-template.js';

const MAXIMUM_MENTIONS_PER_NOTE = 20;

/**
 * The subset of `candidateIds` that are real members of this company, excluding the
 * author. Returns ObjectId-safe strings, deduped, capped — a crafted payload naming
 * every member twenty times cannot turn one note into a mail storm.
 */
export async function resolveMentionedMemberIds(companyId, candidateIds, authorEmployerUserId) {
  if (!Array.isArray(candidateIds) || candidateIds.length === 0) return [];
  const members = await findCompanyMembersByCompanyId(companyId);
  const allowed = new Set(members.map((member) => member.employerUserId.toString()));
  const authorId = authorEmployerUserId?.toString();

  const resolved = [];
  for (const raw of candidateIds) {
    const id = typeof raw === 'string' ? raw : raw?.toString();
    if (!id || id === authorId || !allowed.has(id) || resolved.includes(id)) continue;
    resolved.push(id);
    if (resolved.length >= MAXIMUM_MENTIONS_PER_NOTE) break;
  }
  return resolved;
}

/** Deep link to the applicant detail page the note lives on. */
function applicantUrl(postingId, applicationId) {
  return `${FRONTEND_URL}/employer/jobs/${postingId}/applicants/${applicationId}`;
}

/**
 * Email every mentioned teammate. Awaiting this is optional and the caller does not:
 * a note is saved the moment it is written, and the notification is a courtesy that
 * trails it. Errors are swallowed by sendTransactionalEmail's contract; a missing
 * user or a member without an email address is simply skipped.
 */
export async function notifyMentionedMembers({
  companyId, application, mentionedUserIds, authorName, notePreviewSource,
}) {
  if (!mentionedUserIds || mentionedUserIds.length === 0) return { notified: 0 };

  const [posting, contact] = await Promise.all([
    getPostingForCompany(companyId, application.jobId),
    getContactForCompany(companyId, application.contactId),
  ]);
  const email = buildNoteMentionEmail({
    authorName: authorName || 'A teammate',
    candidateName: contact?.fullName || 'a candidate',
    postingTitle: posting?.title || 'a posting',
    notePreview: buildNotePreview(notePreviewSource),
    applicantUrl: applicantUrl(application.jobId?.toString(), application._id.toString()),
  });

  const results = await Promise.all(mentionedUserIds.map(async (userId) => {
    const user = await getEmployerUserById(userId);
    if (!user?.email) return false;
    const outcome = await sendTransactionalEmail({ to: user.email, ...email });
    return outcome.sent;
  }));
  return { notified: results.filter(Boolean).length };
}

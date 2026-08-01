// FILE: src/services/interview/interview-notification-service.js
// The ONLY place that combines a template, an .ics and sendTransactionalEmail.
// Every send is best-effort: sendTransactionalEmail never rejects, we log its
// code and continue — a failed email must NEVER roll back or fail a booking.
// Exactly ONE .ics per email and no other attachment. The invitation email
// attaches NOTHING: no slot is booked yet, and attaching an invite for an
// unbooked interview would put a phantom event on the candidate's calendar.
// Shared .ics/tally plumbing lives in interview-notification-helpers.js.

import { FRONTEND_URL } from '../../env.js';
import { sendTransactionalEmail as defaultSendEmail } from '../email/send-email-service.js';
import { buildInterviewInviteIcs, buildInterviewCancelIcs } from '../email/build-interview-invite-ics.js';
import { buildInterviewInvitationEmail } from '../email/templates/interview-invitation-template.js';
import {
  buildCandidateConfirmationEmail, buildInterviewerConfirmationEmail,
} from '../email/templates/interview-confirmation-template.js';
import { buildInterviewCancelledEmail } from '../email/templates/interview-cancelled-template.js';
import { buildInterviewReminderEmail } from '../email/templates/interview-reminder-template.js';
import { REMINDER_RECIPIENT_KINDS } from '../../models/interview/interview-reminder-job-model.js';
import { buildIcsInput, icsAttachment, sendAndTally } from './interview-notification-helpers.js';

export function buildBookingUrl(bookingToken) {
  return `${FRONTEND_URL}/interview/${bookingToken}`;
}

/** Slot-picker invitation to the candidate. Template only — NO .ics attached. */
export async function sendInterviewInvitationEmail(context, deps = {}) {
  const { sendEmail = defaultSendEmail } = deps;
  const { interview } = context;
  const summary = { attempted: 0, sent: 0, failed: 0 };
  const { subject, html, text } = buildInterviewInvitationEmail({
    candidateName: context.candidateName,
    companyName: context.companyName,
    postingTitle: context.postingTitle,
    proposedSlots: interview.proposedSlots,
    timezoneId: interview.timezoneId,
    durationMinutes: interview.durationMinutes,
    mode: interview.mode,
    phoneCallDirection: interview.phoneCallDirection,
    locationText: interview.locationText,
    bookingUrl: buildBookingUrl(interview.bookingToken),
    expiresAt: interview.bookingTokenExpiresAt,
  });
  await sendAndTally(sendEmail, summary, { to: context.candidateEmail, subject, html, text });
  return summary;
}

/** The template fields shared by the confirmation + reminder emails. */
function sharedTimeFields(context) {
  const { interview } = context;
  return {
    companyName: context.companyName,
    postingTitle: context.postingTitle,
    startAtUtc: interview.startAtUtc,
    timezoneId: interview.timezoneId,
    durationMinutes: interview.durationMinutes,
    mode: interview.mode,
    meetingUrl: interview.meetingUrl,
    locationText: interview.locationText,
    // Type-aware details for phone / in-person confirmations.
    phoneNumber: interview.phoneNumber,
    phoneCallDirection: interview.phoneCallDirection,
    arrivalInstructions: interview.arrivalInstructions,
    candidatePhone: context.candidatePhone,
  };
}

/** Booked confirmation to the candidate + every interviewer, each with ONE .ics. */
export async function sendInterviewConfirmationEmails(context, deps = {}) {
  const { sendEmail = defaultSendEmail } = deps;
  const { interview } = context;
  const summary = { attempted: 0, sent: 0, failed: 0 };
  const icsString = buildInterviewInviteIcs(buildIcsInput(context, interview.startAtUtc, interview.durationMinutes));
  const attachments = icsAttachment(icsString);
  const shared = sharedTimeFields(context);

  const candidateEmail = buildCandidateConfirmationEmail({
    ...shared, candidateName: context.candidateName, organizerEmail: context.organizerEmail,
  });
  await sendAndTally(sendEmail, summary, { to: context.candidateEmail, ...candidateEmail, attachments });

  const interviewerEmail = buildInterviewerConfirmationEmail({
    ...shared, candidateName: context.candidateName, candidateEmail: context.candidateEmail,
  });
  for (const recipient of context.interviewerEmails) {
    await sendAndTally(sendEmail, summary, { to: recipient, ...interviewerEmail, attachments });
  }
  return summary;
}

/** Cancellation to the same recipients, with the METHOD:CANCEL .ics. The model
 *  has already incremented calendarSequence before this is called. */
export async function sendInterviewCancelledEmails(context, deps = {}) {
  const { sendEmail = defaultSendEmail } = deps;
  const { interview } = context;
  const summary = { attempted: 0, sent: 0, failed: 0 };
  const cancelledStartAtUtc = context.cancelledStartAtUtc ?? interview.startAtUtc ?? interview.proposedSlots[0]?.startAtUtc;
  const icsString = buildInterviewCancelIcs(buildIcsInput(context, cancelledStartAtUtc, interview.durationMinutes));
  const attachments = icsAttachment(icsString);

  const { subject, html, text } = buildInterviewCancelledEmail({
    candidateName: context.candidateName,
    companyName: context.companyName,
    postingTitle: context.postingTitle,
    startAtUtc: cancelledStartAtUtc,
    timezoneId: interview.timezoneId,
    cancelReason: context.cancelReason ?? interview.cancelReason ?? null,
    organizerEmail: context.organizerEmail,
  });
  await sendAndTally(sendEmail, summary, { to: context.candidateEmail, subject, html, text, attachments });
  for (const recipient of context.interviewerEmails) {
    await sendAndTally(sendEmail, summary, { to: recipient, subject, html, text, attachments });
  }
  return summary;
}

/**
 * 24h reminder to one recipient kind, with the .ics re-attached at the CURRENT
 * calendarSequence — nothing changed, so the sequence is NOT incremented.
 */
export async function sendInterviewReminderEmail(context, recipientKind, deps = {}) {
  const { sendEmail = defaultSendEmail } = deps;
  const { interview } = context;
  const summary = { attempted: 0, sent: 0, failed: 0 };
  const icsString = buildInterviewInviteIcs(buildIcsInput(context, interview.startAtUtc, interview.durationMinutes));
  const attachments = icsAttachment(icsString);
  const { subject, html, text } = buildInterviewReminderEmail({
    ...sharedTimeFields(context),
    candidateName: context.candidateName,
    organizerEmail: context.organizerEmail,
    recipientKind,
  });
  const recipients = recipientKind === REMINDER_RECIPIENT_KINDS.CANDIDATE
    ? [context.candidateEmail]
    : context.interviewerEmails;
  for (const recipient of recipients) {
    await sendAndTally(sendEmail, summary, { to: recipient, subject, html, text, attachments });
  }
  return summary;
}

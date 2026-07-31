// FILE: src/services/interview/interview-notification-helpers.js
// Shared plumbing for interview emails, split out of the notification service
// (file-size rule): the .ics input/attachment builders and the send tally.
// Outlook hides the email body when an .ics is attached — everything the
// recipient needs must be inside the description lines built here.

import { CALENDAR_INVITE_CONTENT_TYPE } from '../email/email-constants.js';
import { CALENDAR_INVITE_FILENAME, INTERVIEW_MODES } from '../email/calendar-invite-constants.js';

function buildIcsDescriptionLines(context) {
  const { interview, organizerEmail } = context;
  const lines = [];
  if (interview.mode === INTERVIEW_MODES.VIDEO && interview.meetingUrl) {
    lines.push(`Join the call: ${interview.meetingUrl}`);
  } else if (interview.locationText) {
    lines.push(`Location: ${interview.locationText}`);
  }
  lines.push(`Questions or changes: ${organizerEmail}`);
  return lines;
}

/** Map an email context onto the .ics builders' InterviewInviteInput shape. */
export function buildIcsInput(context, startAtUtc, durationMinutes) {
  const { interview } = context;
  return {
    calendarUid: interview.calendarUid,
    calendarSequence: interview.calendarSequence,
    startAtUtc,
    durationMinutes,
    timezoneId: interview.timezoneId,
    mode: interview.mode,
    meetingUrl: interview.meetingUrl,
    locationText: interview.locationText,
    postingTitle: context.postingTitle,
    companyName: context.companyName,
    candidateName: context.candidateName,
    candidateEmail: context.candidateEmail,
    organizerName: context.organizerName,
    organizerEmail: context.organizerEmail,
    interviewerEmails: context.interviewerEmails,
    descriptionLines: buildIcsDescriptionLines(context),
  };
}

/** Exactly ONE .ics attachment — extra attachments break invite rendering. */
export function icsAttachment(icsString) {
  return [{
    filename: CALENDAR_INVITE_FILENAME,
    content: Buffer.from(icsString).toString('base64'),
    contentType: CALENDAR_INVITE_CONTENT_TYPE,
  }];
}

/** Send one email, tally the outcome, log a non-sent code. Never throws. */
export async function sendAndTally(sendEmail, summary, message) {
  summary.attempted += 1;
  const result = await sendEmail(message);
  if (result.sent) summary.sent += 1;
  else {
    summary.failed += 1;
    console.warn(`[interview-email] send not delivered (code=${result.code})`);
  }
}

// FILE: src/services/email/templates/interview-confirmation-template.js
// Booked-interview confirmations, sent WITH the .ics invite attached.
//
// WARNING — Outlook replaces the email subject with the meeting title and hides
// this body ENTIRELY when a calendar attachment is present. Assume the
// recipient never reads this HTML. The meeting URL, the address, and the
// recruiter contact MUST also travel in the .ics descriptionLines (the
// notification service owns that). This body is a courtesy copy, not the
// source of truth.

import { renderEmailShell, renderPlainText } from './email-layout-helpers.js';
import { formatStartLine } from './email-format-helpers.js';
import { confirmationDetailLines } from './interview-mode-details.js';

/** The mode-specific "where / how" lines, e.g. the video link, the phone
 *  arrangement (who calls whom), or the address + Maps link. */
function detailLines(input) {
  return confirmationDetailLines({
    mode: input.mode,
    meetingUrl: input.meetingUrl,
    locationText: input.locationText,
    arrivalInstructions: input.arrivalInstructions,
    phoneNumber: input.phoneNumber,
    phoneCallDirection: input.phoneCallDirection,
    candidatePhone: input.candidatePhone,
    startLine: formatStartLine(input.startAtUtc, input.timezoneId),
  });
}

export function buildCandidateConfirmationEmail(input) {
  const {
    candidateName, companyName, postingTitle, startAtUtc, timezoneId,
    durationMinutes, organizerEmail,
  } = input;
  const shellInput = {
    previewText: `Your interview with ${companyName} is confirmed`,
    headingText: 'Your interview is confirmed',
    bodyBlocks: [
      `Hi ${candidateName},`,
      `Your interview with ${companyName} for the ${postingTitle} position is confirmed.`,
      `When: ${formatStartLine(startAtUtc, timezoneId)} (${durationMinutes} minutes)`,
      ...detailLines(input),
      `Need to change something? Reply to this email or write to ${organizerEmail}.`,
      'A calendar invitation is attached — accept it and the interview lands in your calendar.',
    ],
    footerLines: [`Sent by JobMesh on behalf of ${companyName}.`],
  };
  return {
    subject: `Interview confirmed: ${postingTitle} at ${companyName}`,
    html: renderEmailShell(shellInput),
    text: renderPlainText(shellInput),
  };
}

export function buildInterviewerConfirmationEmail(input) {
  const {
    candidateName, candidateEmail, companyName, postingTitle, startAtUtc,
    timezoneId, durationMinutes,
  } = input;
  const shellInput = {
    previewText: `Interview booked with ${candidateName} for ${postingTitle}`,
    headingText: 'Interview booked',
    bodyBlocks: [
      `${candidateName} (${candidateEmail}) booked an interview for the ${postingTitle} position at ${companyName}.`,
      `When: ${formatStartLine(startAtUtc, timezoneId)} (${durationMinutes} minutes)`,
      ...detailLines(input),
      'The attached calendar invitation adds it to your calendar.',
    ],
    footerLines: ['Internal notification — not visible to the candidate.'],
  };
  return {
    subject: `Interview booked: ${candidateName} — ${postingTitle}`,
    html: renderEmailShell(shellInput),
    text: renderPlainText(shellInput),
  };
}

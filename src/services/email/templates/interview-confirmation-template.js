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
import { INTERVIEW_MODES } from '../calendar-invite-constants.js';

function whereBlock(mode, meetingUrl, locationText) {
  if (mode === INTERVIEW_MODES.VIDEO) return `Join the call: ${meetingUrl}`;
  return `Location: ${locationText}`;
}

export function buildCandidateConfirmationEmail({
  candidateName, companyName, postingTitle, startAtUtc, timezoneId,
  durationMinutes, mode, meetingUrl, locationText, organizerEmail,
}) {
  const shellInput = {
    previewText: `Your interview with ${companyName} is confirmed`,
    headingText: 'Your interview is confirmed',
    bodyBlocks: [
      `Hi ${candidateName},`,
      `Your interview with ${companyName} for the ${postingTitle} position is confirmed.`,
      `When: ${formatStartLine(startAtUtc, timezoneId)} (${durationMinutes} minutes)`,
      whereBlock(mode, meetingUrl, locationText),
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

export function buildInterviewerConfirmationEmail({
  candidateName, candidateEmail, companyName, postingTitle, startAtUtc,
  timezoneId, durationMinutes, mode, meetingUrl, locationText,
}) {
  const shellInput = {
    previewText: `Interview booked with ${candidateName} for ${postingTitle}`,
    headingText: 'Interview booked',
    bodyBlocks: [
      `${candidateName} (${candidateEmail}) booked an interview for the ${postingTitle} position at ${companyName}.`,
      `When: ${formatStartLine(startAtUtc, timezoneId)} (${durationMinutes} minutes)`,
      whereBlock(mode, meetingUrl, locationText),
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

// FILE: src/services/email/templates/interview-reminder-template.js
// 24-hour reminder, sent WITH the .ics re-attached at the CURRENT
// calendarSequence — nothing changed, so the sequence is NOT incremented.
// Re-sending the identical UID + sequence is a no-op for a calendar that
// already has the event and a recovery for one that lost it.
//
// WARNING — Outlook replaces the email subject with the meeting title and hides
// this body ENTIRELY when a calendar attachment is present. The meeting URL /
// address must also travel in the .ics descriptionLines (notification service).

import { renderEmailShell, renderPlainText } from './email-layout-helpers.js';
import { formatStartLine } from './email-format-helpers.js';
import { INTERVIEW_MODES } from '../calendar-invite-constants.js';

const MODE_LABELS = Object.freeze({
  [INTERVIEW_MODES.VIDEO]: 'Video call',
  [INTERVIEW_MODES.PHONE]: 'Phone call',
  [INTERVIEW_MODES.IN_PERSON]: 'In person',
});

export function buildInterviewReminderEmail({
  candidateName, companyName, postingTitle, startAtUtc, timezoneId,
  durationMinutes, mode, meetingUrl, locationText, organizerEmail, recipientKind,
}) {
  const isCandidate = recipientKind === 'candidate';
  const whereBlock = mode === INTERVIEW_MODES.VIDEO
    ? `Join the call: ${meetingUrl}`
    : `Location: ${locationText}`;
  const shellInput = {
    previewText: `Reminder: interview tomorrow — ${postingTitle}`,
    headingText: 'Interview reminder — tomorrow',
    bodyBlocks: [
      isCandidate
        ? `Hi ${candidateName}, a reminder that your interview with ${companyName} for the ${postingTitle} position is tomorrow.`
        : `Reminder: your interview with ${candidateName} for the ${postingTitle} position is tomorrow.`,
      `When: ${formatStartLine(startAtUtc, timezoneId)} (${durationMinutes} minutes)`,
      `${MODE_LABELS[mode] ?? mode} — ${whereBlock}`,
      isCandidate
        ? `Need to change something? Write to ${organizerEmail}.`
        : 'The attached calendar invitation restores the event if your calendar lost it.',
    ],
    footerLines: [isCandidate ? `Sent by JobMesh on behalf of ${companyName}.` : 'Internal notification — not visible to the candidate.'],
  };
  return {
    subject: `Reminder: interview tomorrow — ${postingTitle} at ${companyName}`,
    html: renderEmailShell(shellInput),
    text: renderPlainText(shellInput),
  };
}

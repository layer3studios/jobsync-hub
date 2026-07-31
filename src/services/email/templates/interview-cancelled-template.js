// FILE: src/services/email/templates/interview-cancelled-template.js
// Cancellation notice, sent WITH the METHOD:CANCEL .ics attached.
//
// WARNING — Outlook replaces the email subject with the meeting title and hides
// this body ENTIRELY when a calendar attachment is present. Assume the
// recipient never reads this HTML. Any contact or follow-up detail MUST also
// travel in the .ics descriptionLines (the notification service owns that).
// This body is a courtesy copy, not the source of truth.

import { renderEmailShell, renderPlainText } from './email-layout-helpers.js';
import { formatStartLine } from './email-format-helpers.js';

export function buildInterviewCancelledEmail({
  candidateName, companyName, postingTitle, startAtUtc, timezoneId,
  cancelReason, organizerEmail,
}) {
  const bodyBlocks = [
    `Hi ${candidateName},`,
    `Your interview with ${companyName} for the ${postingTitle} position has been cancelled.`,
  ];
  if (startAtUtc) {
    bodyBlocks.push(`Originally scheduled for: ${formatStartLine(startAtUtc, timezoneId)}`);
  }
  if (cancelReason) bodyBlocks.push(`Reason: ${cancelReason}`);
  bodyBlocks.push(
    'The attached calendar update removes the event from your calendar.',
    `Questions? Write to ${organizerEmail}.`,
  );

  const shellInput = {
    previewText: `Your interview with ${companyName} has been cancelled`,
    headingText: 'Interview cancelled',
    bodyBlocks,
    footerLines: [`Sent by JobMesh on behalf of ${companyName}.`],
  };
  return {
    subject: `Interview cancelled: ${postingTitle} at ${companyName}`,
    html: renderEmailShell(shellInput),
    text: renderPlainText(shellInput),
  };
}

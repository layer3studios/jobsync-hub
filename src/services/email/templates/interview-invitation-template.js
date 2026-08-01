// FILE: src/services/email/templates/interview-invitation-template.js
// Slot-picker invitation. No .ics is ever attached with this email — nothing is
// scheduled yet — so unlike the confirmation templates, this body IS what the
// candidate reads. meetingUrl is never included: it is revealed only in the
// confirmation email after a slot is booked.

import { renderEmailShell, renderPlainText } from './email-layout-helpers.js';
import { formatSlotLine, formatExpiryDate } from './email-format-helpers.js';
import { INTERVIEW_MODES } from '../calendar-invite-constants.js';
import { afterBookingLine } from './interview-mode-details.js';

const MODE_LABELS = Object.freeze({
  [INTERVIEW_MODES.VIDEO]: 'video call',
  [INTERVIEW_MODES.PHONE]: 'phone call',
  [INTERVIEW_MODES.IN_PERSON]: 'in-person interview',
});

export function buildInterviewInvitationEmail({
  candidateName, companyName, postingTitle, proposedSlots, timezoneId,
  durationMinutes, mode, phoneCallDirection, locationText, bookingUrl, expiresAt,
}) {
  const modeLabel = MODE_LABELS[mode] ?? mode;
  const bodyBlocks = [
    `Hi ${candidateName},`,
    `${companyName} would like to schedule a ${durationMinutes}-minute ${modeLabel} with you for the ${postingTitle} position.`,
  ];
  if (proposedSlots.length > 0) {
    bodyBlocks.push(
      'Pick whichever of these times works best for you:',
      ...proposedSlots.map((slot, index) =>
        `Option ${index + 1}: ${formatSlotLine(slot.startAtUtc, slot.durationMinutes, timezoneId)}`),
    );
  } else {
    // Pool invitation: the candidate picks from live availability on the
    // booking page, so no specific times are listed here.
    bodyBlocks.push('Choose a time that works for you from the available options on the booking page.');
  }
  if (mode === INTERVIEW_MODES.IN_PERSON && locationText) {
    bodyBlocks.push(`Location: ${locationText}`);
  }
  // What happens after booking, by mode — the candidate should know what to
  // expect before they commit to a time.
  bodyBlocks.push(afterBookingLine({ mode, phoneCallDirection }));
  bodyBlocks.push(`This link expires on ${formatExpiryDate(expiresAt, timezoneId)}.`);

  const shellInput = {
    previewText: `${companyName} wants to interview you for ${postingTitle} — pick a time`,
    headingText: `Interview invitation from ${companyName}`,
    bodyBlocks,
    buttonLabel: 'Choose your interview time',
    buttonUrl: bookingUrl,
    footerLines: [
      `You received this email because you applied to ${companyName} through JobMesh.`,
    ],
  };
  return {
    subject: `Interview invitation: ${postingTitle} at ${companyName}`,
    html: renderEmailShell(shellInput),
    text: renderPlainText(shellInput),
  };
}

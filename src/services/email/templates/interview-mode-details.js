// FILE: src/services/email/templates/interview-mode-details.js
// The ONE mode → "what happens / where to go" mapping, shared by the
// invitation email, both confirmation emails and the .ics description — so the
// three surfaces can never disagree about a phone or in-person interview.

import { INTERVIEW_MODES } from '../calendar-invite-constants.js';
import { PHONE_CALL_DIRECTIONS } from '../../../models/interview/interview-constants.js';

export function googleMapsUrl(locationText) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(locationText)}`;
}

/** Invitation: what the candidate can expect AFTER booking, by mode. */
export function afterBookingLine({ mode, phoneCallDirection }) {
  if (mode === INTERVIEW_MODES.VIDEO) return "Once you confirm, you'll receive a video call link.";
  if (mode === INTERVIEW_MODES.PHONE) {
    return phoneCallDirection === PHONE_CALL_DIRECTIONS.CANDIDATE_CALLS
      ? "Once you confirm, you'll receive a number to call."
      : "Once you confirm, we'll call you at the scheduled time.";
  }
  return "Once you confirm, you'll receive the office address and directions.";
}

/**
 * Confirmation / .ics detail lines, by mode. `startLine` is the formatted
 * time ("Sat, 2 Aug at 9:30 AM IST") used in the phone sentences.
 */
export function confirmationDetailLines({
  mode, meetingUrl, locationText, arrivalInstructions,
  phoneNumber, phoneCallDirection, candidatePhone, startLine,
}) {
  if (mode === INTERVIEW_MODES.VIDEO) return [`Join here: ${meetingUrl}`];
  if (mode === INTERVIEW_MODES.PHONE) {
    if (phoneCallDirection === PHONE_CALL_DIRECTIONS.CANDIDATE_CALLS) {
      return [`Please call us at ${phoneNumber} at ${startLine}.`];
    }
    return candidatePhone
      ? [`We will call you at ${candidatePhone} at ${startLine}.`]
      : ['Please reply with your phone number so we can reach you.'];
  }
  const lines = [`Location: ${locationText}`];
  if (arrivalInstructions) lines.push(arrivalInstructions);
  lines.push(`Open in Google Maps: ${googleMapsUrl(locationText)}`);
  return lines;
}

// FILE: src/services/email/templates/email-format-helpers.js
// Shared human-readable date formatting for interview emails, via luxon.
// All interview times are stored UTC and rendered in the interview's timezone.

import { DateTime } from 'luxon';
import { DEFAULT_INTERVIEW_TIMEZONE } from '../calendar-invite-constants.js';

const SLOT_DATE_FORMAT = "cccc, d LLLL yyyy 'at' h:mm a";
const EXPIRY_DATE_FORMAT = 'd LLLL yyyy';

/** e.g. "Monday, 10 August 2026 at 3:00 PM IST (45 minutes)". */
export function formatSlotLine(startAtUtc, durationMinutes, timezoneId = DEFAULT_INTERVIEW_TIMEZONE) {
  const local = DateTime.fromJSDate(startAtUtc, { zone: timezoneId });
  return `${local.toFormat(SLOT_DATE_FORMAT)} ${local.offsetNameShort} (${durationMinutes} minutes)`;
}

/** e.g. "Monday, 10 August 2026 at 3:00 PM IST". */
export function formatStartLine(startAtUtc, timezoneId = DEFAULT_INTERVIEW_TIMEZONE) {
  const local = DateTime.fromJSDate(startAtUtc, { zone: timezoneId });
  return `${local.toFormat(SLOT_DATE_FORMAT)} ${local.offsetNameShort}`;
}

/** e.g. "7 August 2026". */
export function formatExpiryDate(expiresAt, timezoneId = DEFAULT_INTERVIEW_TIMEZONE) {
  return DateTime.fromJSDate(expiresAt, { zone: timezoneId }).toFormat(EXPIRY_DATE_FORMAT);
}

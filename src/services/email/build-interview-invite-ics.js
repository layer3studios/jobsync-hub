// FILE: src/services/email/build-interview-invite-ics.js
// Pure RFC 5545 generators for interview invites (METHOD:REQUEST) and
// cancellations (METHOD:CANCEL). No models, no routes, no database — the input
// is a plain object so this stays independently testable until the interviews
// collection exists (chunk 3).
//
// PRODUCT REQUIREMENT — description content: Outlook replaces the email subject
// with the meeting title and hides the email body entirely when a calendar
// attachment is present. Assume the recipient never sees the HTML email. The
// meeting URL, any reschedule link and the recruiter's contact MUST therefore be
// passed in descriptionLines so they land inside the .ics DESCRIPTION.
//
// Reschedules reuse the same calendarUid with an incremented calendarSequence —
// that is how calendar clients move the existing event instead of duplicating it.
// ical-generator handles escaping and 75-octet folding; tests verify both
// against real output rather than trusting the library.

import ical, { ICalCalendarMethod, ICalEventStatus } from 'ical-generator';
import { getVtimezoneComponent as defaultGetVtimezoneComponent } from '@touch4it/ical-timezones';
import { CALENDAR_PRODUCT_ID, DEFAULT_INTERVIEW_TIMEZONE, INTERVIEW_MODES } from './calendar-invite-constants.js';

const MILLISECONDS_PER_MINUTE = 60 * 1000;

/** Basic iCalendar UTC form, e.g. 20260810T053000Z. */
function toUtcTimestamp(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/**
 * RFC 5545 requires DTSTAMP in UTC with a trailing Z, but ical-generator
 * serializes DTSTAMP as floating local time whenever a calendar-level timezone
 * is set. A floating DTSTAMP can make clients mis-order updates/cancels against
 * the original invite — exactly the reschedule path we depend on. DTSTART/DTEND
 * must stay TZID-qualified (no Z), so only the DTSTAMP line is rewritten.
 */
function rewriteDtstampAsUtc(icsString, stampAtUtc) {
  return icsString.replace(/^DTSTAMP:.*$/m, `DTSTAMP:${toUtcTimestamp(stampAtUtc)}`);
}

/**
 * @typedef {object} InterviewInviteInput
 * @property {string} calendarUid stable for the life of the interview
 * @property {number} calendarSequence starts at 0, increments on every change
 * @property {Date} startAtUtc
 * @property {number} durationMinutes
 * @property {string} [timezoneId] IANA id, defaults to DEFAULT_INTERVIEW_TIMEZONE
 * @property {string} mode one of INTERVIEW_MODES
 * @property {string|null} meetingUrl video mode
 * @property {string|null} locationText phone / in_person mode
 * @property {string} postingTitle
 * @property {string} companyName
 * @property {string} candidateName
 * @property {string} candidateEmail
 * @property {string} organizerName
 * @property {string} organizerEmail
 * @property {string[]} interviewerEmails may be empty
 * @property {string[]} descriptionLines may be empty — but see the header:
 *   meeting URL / reschedule link / recruiter contact belong here
 */

/** LOCATION by mode: the join URL, "Phone call" (no physical place), or the address. */
function resolveLocation(input) {
  if (input.mode === INTERVIEW_MODES.VIDEO) return input.meetingUrl;
  if (input.mode === INTERVIEW_MODES.PHONE) return 'Phone call';
  return input.locationText;
}

/** One calendar + one event, shared by both builders. Returns the ICS string. */
function buildCalendarString(input, method, eventOverrides, deps) {
  const { getVtimezoneComponent = defaultGetVtimezoneComponent } = deps;
  const timezoneId = input.timezoneId || DEFAULT_INTERVIEW_TIMEZONE;
  const stampAtUtc = new Date();

  const calendar = ical({
    // ical-generator prepends the leading '-' to string prodIds itself.
    prodId: CALENDAR_PRODUCT_ID.replace(/^-/, ''),
    method,
  });
  // CRITICAL: without this generator no VTIMEZONE block is emitted, and a TZID
  // with no matching VTIMEZONE makes Outlook render the event in UTC (a 5.5h
  // error for Asia/Kolkata).
  calendar.timezone({ name: timezoneId, generator: getVtimezoneComponent });

  const event = calendar.createEvent({
    stamp: stampAtUtc,
    id: input.calendarUid,
    sequence: input.calendarSequence,
    timezone: timezoneId,
    start: input.startAtUtc,
    end: new Date(input.startAtUtc.getTime() + input.durationMinutes * MILLISECONDS_PER_MINUTE),
    summary: `Interview: ${input.postingTitle} at ${input.companyName}`,
    location: resolveLocation(input),
    description: input.descriptionLines.join('\n'),
    organizer: { name: input.organizerName, email: input.organizerEmail },
    ...eventOverrides,
  });

  event.createAttendee({ email: input.candidateEmail, name: input.candidateName, rsvp: true });
  for (const interviewerEmail of input.interviewerEmails) {
    event.createAttendee({ email: interviewerEmail });
  }

  return rewriteDtstampAsUtc(calendar.toString(), stampAtUtc);
}

/**
 * METHOD:REQUEST invite. Used for both the first invite and any reschedule —
 * same UID, incremented SEQUENCE.
 * @param {InterviewInviteInput} input
 * @returns {string}
 */
export function buildInterviewInviteIcs(input, deps = {}) {
  return buildCalendarString(input, ICalCalendarMethod.REQUEST, {}, deps);
}

/**
 * METHOD:CANCEL with STATUS:CANCELLED. The caller increments calendarSequence.
 * @param {InterviewInviteInput} input
 * @returns {string}
 */
export function buildInterviewCancelIcs(input, deps = {}) {
  return buildCalendarString(input, ICalCalendarMethod.CANCEL, { status: ICalEventStatus.CANCELLED }, deps);
}

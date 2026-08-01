// FILE: src/models/interview/interview-validators.js
// Pure validation helpers for interview input — no DB. Each throws
// HttpError(400, message, code) on bad input and returns the normalized value
// on success, matching services/employer/posting-validators.js.

import { HttpError } from '../../middleware/error-handler-middleware.js';
import {
  INTERVIEW_MODES, INTERVIEW_ERROR_CODES, PHONE_CALL_DIRECTIONS,
  MINIMUM_PROPOSED_SLOTS, MAXIMUM_PROPOSED_SLOTS,
} from './interview-constants.js';

const MINIMUM_DURATION_MINUTES = 15;
const MAXIMUM_DURATION_MINUTES = 480;
const ABSOLUTE_HTTP_URL_PATTERN = /^https?:\/\/\S+$/i;

const INTERVIEW_MODE_VALUES = Object.values(INTERVIEW_MODES);

function isValidSlot(slot) {
  return slot
    && slot.startAtUtc instanceof Date
    && !Number.isNaN(slot.startAtUtc.getTime())
    && Number.isInteger(slot.durationMinutes)
    && slot.durationMinutes > 0;
}

/** 2-4 future, positive-duration, mutually distinct slots. Returns the array. */
export function validateProposedSlots(slots, now = new Date()) {
  if (!Array.isArray(slots) || slots.length < MINIMUM_PROPOSED_SLOTS) {
    throw new HttpError(400, `Propose at least ${MINIMUM_PROPOSED_SLOTS} slots`, INTERVIEW_ERROR_CODES.TOO_FEW_SLOTS);
  }
  if (slots.length > MAXIMUM_PROPOSED_SLOTS) {
    throw new HttpError(400, `Propose at most ${MAXIMUM_PROPOSED_SLOTS} slots`, INTERVIEW_ERROR_CODES.TOO_MANY_SLOTS);
  }
  const seenSlotKeys = new Set();
  for (const slot of slots) {
    if (!isValidSlot(slot)) {
      throw new HttpError(400, 'Each slot needs a startAtUtc Date and a positive durationMinutes', INTERVIEW_ERROR_CODES.INVALID_SLOT);
    }
    if (slot.startAtUtc <= now) {
      throw new HttpError(400, 'Each slot must start in the future', INTERVIEW_ERROR_CODES.INVALID_SLOT);
    }
    const slotKey = `${slot.startAtUtc.getTime()}:${slot.durationMinutes}`;
    if (seenSlotKeys.has(slotKey)) {
      throw new HttpError(400, 'Proposed slots must be distinct', INTERVIEW_ERROR_CODES.INVALID_SLOT);
    }
    seenSlotKeys.add(slotKey);
  }
  return slots;
}

export function validateInterviewMode(mode) {
  if (!INTERVIEW_MODE_VALUES.includes(mode)) {
    throw new HttpError(400, `Mode must be one of: ${INTERVIEW_MODE_VALUES.join(', ')}`, INTERVIEW_ERROR_CODES.INVALID_MODE);
  }
  return mode;
}

export function validateDurationMinutes(minutes) {
  if (!Number.isInteger(minutes) || minutes < MINIMUM_DURATION_MINUTES || minutes > MAXIMUM_DURATION_MINUTES) {
    throw new HttpError(
      400,
      `Duration must be an integer between ${MINIMUM_DURATION_MINUTES} and ${MAXIMUM_DURATION_MINUTES} minutes`,
      INTERVIEW_ERROR_CODES.INVALID_DURATION,
    );
  }
  return minutes;
}

const trimmedOrNull = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);

function requireValidMeetingUrl(meetingUrl) {
  if (typeof meetingUrl !== 'string' || !ABSOLUTE_HTTP_URL_PATTERN.test(meetingUrl.trim())) {
    throw new HttpError(400, 'Video interviews require an absolute http(s) meetingUrl', INTERVIEW_ERROR_CODES.INVALID_MEETING_LOCATION);
  }
  return meetingUrl.trim();
}

/**
 * Mode-dependent details. The wrong combination is rejected, never silently
 * ignored: phone needs the interviewer's phoneNumber AND a phoneCallDirection
 * (who dials whom); in_person needs the address in locationText, with optional
 * arrivalInstructions ("ask for X at reception, parking in basement").
 *
 * VIDEO's meetingUrl is OPTIONAL here — the link is entered per-DATE on each
 * interview_times document, so "type + duration, no link yet" is a valid
 * defaults state. A link that IS supplied still has to be a real absolute URL.
 * The "a video interview needs a link" rule now lives at SEND time
 * (pool-scheduling-service), where a link is actually about to reach a
 * candidate — see requireSendableVideoLink.
 */
export function validateMeetingLocation(mode, meetingUrl, locationText, { phoneNumber, phoneCallDirection, arrivalInstructions } = {}) {
  validateInterviewMode(mode);
  const blank = {
    meetingUrl: null, locationText: null, phoneNumber: null, phoneCallDirection: null, arrivalInstructions: null,
  };
  if (mode === INTERVIEW_MODES.VIDEO) {
    return {
      ...blank,
      meetingUrl: trimmedOrNull(meetingUrl) ? requireValidMeetingUrl(meetingUrl) : null,
      locationText: trimmedOrNull(locationText),
    };
  }
  if (mode === INTERVIEW_MODES.PHONE) {
    if (!trimmedOrNull(phoneNumber)) {
      throw new HttpError(400, 'Phone interviews require the interviewer\'s phoneNumber', INTERVIEW_ERROR_CODES.INVALID_PHONE_DETAILS);
    }
    if (!Object.values(PHONE_CALL_DIRECTIONS).includes(phoneCallDirection)) {
      throw new HttpError(400, 'Phone interviews require phoneCallDirection (we_call | candidate_calls)', INTERVIEW_ERROR_CODES.INVALID_PHONE_DETAILS);
    }
    return {
      ...blank,
      phoneNumber: phoneNumber.trim(),
      phoneCallDirection,
      meetingUrl: meetingUrl ? requireValidMeetingUrl(meetingUrl) : null,
      locationText: trimmedOrNull(locationText),
    };
  }
  // in_person: the address is mandatory; extra directions are optional.
  if (!trimmedOrNull(locationText)) {
    throw new HttpError(400, 'In-person interviews require locationText (the address)', INTERVIEW_ERROR_CODES.INVALID_MEETING_LOCATION);
  }
  return {
    ...blank,
    locationText: locationText.trim(),
    arrivalInstructions: trimmedOrNull(arrivalInstructions),
  };
}

/**
 * SEND-time gate: a video interview about to be offered to a candidate must
 * carry a link somewhere — on the time being offered, or on the posting's
 * defaults. Saving defaults no longer enforces this (the link is per-date).
 */
export function requireSendableVideoLink(mode, meetingUrl) {
  if (mode !== INTERVIEW_MODES.VIDEO) return null;
  return requireValidMeetingUrl(meetingUrl);
}

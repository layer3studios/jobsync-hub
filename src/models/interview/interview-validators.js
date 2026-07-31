// FILE: src/models/interview/interview-validators.js
// Pure validation helpers for interview input — no DB. Each throws
// HttpError(400, message, code) on bad input and returns the normalized value
// on success, matching services/employer/posting-validators.js.

import { HttpError } from '../../middleware/error-handler-middleware.js';
import {
  INTERVIEW_MODES, INTERVIEW_ERROR_CODES,
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

/**
 * Mode-dependent location requirement. The wrong combination is rejected, never
 * silently ignored: video needs an absolute http(s) meetingUrl; phone and
 * in_person need non-empty locationText.
 */
export function validateMeetingLocation(mode, meetingUrl, locationText) {
  validateInterviewMode(mode);
  if (mode === INTERVIEW_MODES.VIDEO) {
    if (typeof meetingUrl !== 'string' || !ABSOLUTE_HTTP_URL_PATTERN.test(meetingUrl.trim())) {
      throw new HttpError(400, 'Video interviews require an absolute http(s) meetingUrl', INTERVIEW_ERROR_CODES.INVALID_MEETING_LOCATION);
    }
    return { meetingUrl: meetingUrl.trim(), locationText: null };
  }
  if (typeof locationText !== 'string' || !locationText.trim()) {
    throw new HttpError(400, 'Phone and in-person interviews require locationText', INTERVIEW_ERROR_CODES.INVALID_MEETING_LOCATION);
  }
  return { meetingUrl: null, locationText: locationText.trim() };
}

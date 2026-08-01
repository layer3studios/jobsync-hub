// FILE: src/models/interview/interview-constants.js
// Frozen constants for the interviews collection — no magic strings downstream.

import { INTERVIEW_MODES } from '../../services/email/calendar-invite-constants.js';

// Single source of truth for modes lives with the .ics generator; re-exported
// here so model code never redefines it.
export { INTERVIEW_MODES };

export const INTERVIEW_STATUSES = Object.freeze({
  PROPOSED: 'proposed',
  SCHEDULED: 'scheduled',
  CANCELLED: 'cancelled',
  COMPLETED: 'completed',
  NO_SHOW: 'no_show',
});

export const MINIMUM_PROPOSED_SLOTS = 2;
export const MAXIMUM_PROPOSED_SLOTS = 4;

export const BOOKING_TOKEN_BYTE_LENGTH = 32;
export const BOOKING_TOKEN_TTL_DAYS = 7;

// A candidate must not book a slot starting within the next hour — the
// interviewer needs at least that much notice. Greenhouse uses 24h; we use 1h
// because Indian SMB hiring moves same-day and a 24h wall would kill most of
// the slots employers actually propose.
export const MINIMUM_BOOKING_LEAD_MINUTES = 60;

// Post-interview feedback (Part 1). Four-point scale — no neutral option, so
// the interviewer must lean one way (mirrors Greenhouse/Lever scorecards).
export const INTERVIEW_RECOMMENDATIONS = Object.freeze({
  STRONG_YES: 'strong_yes',
  YES: 'yes',
  NO: 'no',
  STRONG_NO: 'strong_no',
});

// Optional fields get skipped — feedback is required, with a floor that forces
// at least one real sentence.
export const FEEDBACK_TEXT_MINIMUM_LENGTH = 10;

// Phone interviews: who dials whom. Null for video / in-person interviews.
export const PHONE_CALL_DIRECTIONS = Object.freeze({
  WE_CALL: 'we_call',
  CANDIDATE_CALLS: 'candidate_calls',
});

export const INTERVIEW_ERROR_CODES = Object.freeze({
  INTERVIEW_NOT_FOUND: 'INTERVIEW_NOT_FOUND',
  INVALID_SLOT: 'INVALID_SLOT',
  SLOT_ALREADY_BOOKED: 'SLOT_ALREADY_BOOKED',
  BOOKING_TOKEN_INVALID: 'BOOKING_TOKEN_INVALID',
  BOOKING_TOKEN_EXPIRED: 'BOOKING_TOKEN_EXPIRED',
  INTERVIEW_NOT_PROPOSED: 'INTERVIEW_NOT_PROPOSED',
  SLOT_TOO_SOON: 'SLOT_TOO_SOON',
  TOO_FEW_SLOTS: 'TOO_FEW_SLOTS',
  TOO_MANY_SLOTS: 'TOO_MANY_SLOTS',
  INVALID_MODE: 'INVALID_MODE',
  INVALID_DURATION: 'INVALID_DURATION',
  INVALID_MEETING_LOCATION: 'INVALID_MEETING_LOCATION',
  INTERVIEW_ALREADY_ACTIVE: 'INTERVIEW_ALREADY_ACTIVE',
  // Pool scheduling (interview_times)
  TIME_NOT_FOUND: 'TIME_NOT_FOUND',
  TIME_ALREADY_BOOKED: 'TIME_ALREADY_BOOKED',
  TIME_TOO_SOON: 'TIME_TOO_SOON',
  POOL_EMPTY: 'POOL_EMPTY',
  NO_INTERVIEW_DEFAULTS: 'NO_INTERVIEW_DEFAULTS',
  POOL_REQUIRES_TIME_ID: 'POOL_REQUIRES_TIME_ID',
  MANUAL_REQUIRES_SLOT_INDEX: 'MANUAL_REQUIRES_SLOT_INDEX',
  // Post-interview outcome (Part 1)
  INTERVIEW_NOT_YET: 'INTERVIEW_NOT_YET',
  INTERVIEW_NOT_SCHEDULED: 'INTERVIEW_NOT_SCHEDULED',
  INVALID_RECOMMENDATION: 'INVALID_RECOMMENDATION',
  FEEDBACK_TOO_SHORT: 'FEEDBACK_TOO_SHORT',
  // Type-aware interviews (phone / in-person details)
  INVALID_PHONE_DETAILS: 'INVALID_PHONE_DETAILS',
});

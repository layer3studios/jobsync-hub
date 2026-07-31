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
});

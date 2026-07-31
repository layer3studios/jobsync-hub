// FILE: src/services/email/calendar-invite-constants.js
// Shared constants for interview calendar-invite generation. The attachment
// Content-Type lives in email-constants.js (CALENDAR_INVITE_CONTENT_TYPE) —
// import it from there, never duplicate it.

export const DEFAULT_INTERVIEW_TIMEZONE = 'Asia/Kolkata';

export const CALENDAR_PRODUCT_ID = '-//JobMesh//Interview Scheduling//EN';

export const INTERVIEW_MODES = Object.freeze({
  VIDEO: 'video',
  PHONE: 'phone',
  IN_PERSON: 'in_person',
});

export const CALENDAR_INVITE_FILENAME = 'interview.ics';

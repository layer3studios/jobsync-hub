// FILE: src/services/email/email-constants.js
// Shared constants for the transactional email stack. Every string that email
// code branches on lives here — no magic strings at call sites.

export const EMAIL_ERROR_CODES = Object.freeze({
  EMAIL_DISABLED: 'EMAIL_DISABLED',
  EMAIL_NOT_CONFIGURED: 'EMAIL_NOT_CONFIGURED',
  INVALID_RECIPIENT: 'INVALID_RECIPIENT',
  SEND_FAILED: 'SEND_FAILED',
  RATE_LIMITED: 'RATE_LIMITED',
});

// Resend's hard limit is 40MB per email AFTER Base64 encoding (~+33% overhead).
// We cap raw attachment bytes at a conservative 10MB so a single .ics or PDF can
// never push the encoded payload anywhere near the platform ceiling.
export const MAXIMUM_ATTACHMENT_SIZE_BYTES = 10 * 1024 * 1024;

// Outlook only renders an .ics attachment as an actual meeting invitation when
// the attachment Content-Type is EXACTLY this value (method=REQUEST included).
export const CALENDAR_INVITE_CONTENT_TYPE = 'text/calendar; charset=utf-8; method=REQUEST';
